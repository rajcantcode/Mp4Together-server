import express from "express";
import mongoose from "mongoose";
import dotenv from "dotenv";
import http from "http";
import cors from "cors";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import { Room } from "./model/Room.js";
import { Server } from "socket.io";
import helmet from "helmet";

// Import routers
import authRouter from "./routes/Auth.js";
import roomRouter from "./routes/Room.js";
// Helper functions
import {
  assignSocket,
  checkTokenAndSetUserSocketId,
  authenticateToken,
} from "./helpers.js";

dotenv.config();
const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: [process.env.FRONTENDURL],
    credentials: true,
    methods: ["GET", "POST"],
  },
});

// app.disable("x-powered-by");
app.use(helmet());
helmet.hidePoweredBy({ setTo: "deeznuts" });
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(
  cors({
    origin: [process.env.FRONTENDURL],
    credentials: true, // Allow cookies to be sent with the request
  })
);
app.use(express.json());
app.use(cookieParser());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per `window` (here, per 15 minutes)
  standardHeaders: true, // Return rate limit info in the `RateLimit-*` headers
  legacyHeaders: false, // Disable the `X-RateLimit-*` headers
  message: async () => {
    return "Prease stoppu you are hurting me 😢";
  },
});

app.use(limiter);
app.use("/auth", authRouter);
app.use("/room", authenticateToken, roomRouter);

main().catch((err) => console.error(err));

async function main() {
  await mongoose.connect(process.env.DBLINK);
}

const usernameToSocketId = {};
// Socket code
io.on("connection", async (socket) => {
  // Authenticate socket connection
  const cookies = socket.handshake.headers.cookie;
  const token = cookies?.split("accessToken=")[1].split(";")[0];
  if (!token) {
    socket.disconnect();
    return;
  }
  const isValidToken = await checkTokenAndSetUserSocketId(token, socket.id);
  if (!isValidToken) {
    socket.disconnect();
    return;
  }

  // Join a room
  socket.on("join", async ({ room, username }) => {
    socket.join(room);
    if (usernameToSocketId[room]) {
      usernameToSocketId[room][username] = socket.id;
    } else {
      usernameToSocketId[room] = {};
      usernameToSocketId[room][username] = socket.id;
    }
  });

  // Listen for messages
  socket.on("sent-message", (data) => {
    socket.to(data.room).emit("receive-message", { ...data.msgObj });
  });

  // Listen when user exits the room
  socket.on("exit-room", async (data) => {
    try {
      const msgObj = {
        type: "notification",
        message: `${data.username} left the room`,
      };
      const room = await Room.findOne({
        mainRoomId: data.mainRoomId,
      })
        .populate("members", "username")
        .populate("admins", "username")
        .exec();
      if (usernameToSocketId[data.room][data.username]) {
        delete usernameToSocketId[data.room][data.username];
      }
      if (Object.keys(usernameToSocketId[data.room]).length === 0) {
        delete usernameToSocketId[data.room];
      }

      // Send the message to other users, that a user exited the room
      if (room) {
        socket.to(data.room).emit("exit-msg", {
          msgObj,
          members: room.members.flatMap(({ username }) => username),
          admins: room.admins.flatMap(({ username }) => username),
          membersMicState: room.membersMicState,
          leaver: data.username,
        });
      } else {
        socket.to(data.room).emit("exit-msg", {
          msgObj,
        });
      }
    } catch (error) {
      console.error(error);
    }
  });

  socket.on(
    "send-timestamp",
    async ({ timestamp, socketRoom, username, admin, execute }) => {
      if (!usernameToSocketId[socketRoom][username]) {
        await assignSocket(usernameToSocketId, socketRoom, username);
      }
      if (!usernameToSocketId[socketRoom][admin]) {
        await assignSocket(usernameToSocketId, socketRoom, admin);
      }
      io.to(usernameToSocketId[socketRoom][username]).emit("timestamp", {
        timestamp,
        execute,
      });
      if (execute) {
        io.to(usernameToSocketId[socketRoom][admin]).emit("received-timestamp");
      }
    }
  );

  // Listen when user joins the room
  socket.on(
    "join-room",
    async ({ room: socketRoom, username, mainRoomId, admin }) => {
      const msgObj = {
        type: "notification",
        message: `${username} joined the room`,
      };
      const room = await Room.findOne({ mainRoomId })
        .populate("members", "username")
        .populate("admins", "username")
        .exec();
      if (!usernameToSocketId[socketRoom][username]) {
        await assignSocket(usernameToSocketId, socketRoom, username);
      }
      if (!usernameToSocketId[socketRoom][admin]) {
        await assignSocket(usernameToSocketId, socketRoom, admin);
      }
      // Send a socket event to admin to get the current timestamp of video, if video exists
      if (room.videoUrl) {
        io.to(usernameToSocketId[socketRoom][admin]).emit("get-timestamp", {
          requester: username,
        });
      } else {
        io.to(usernameToSocketId[socketRoom][username]).emit("timestamp", {
          timestamp: 0,
        });
      }
      // Send the message to other users, that a user joined the room
      socket.to(socketRoom).emit("join-msg", {
        msgObj,
        members: room.members.flatMap(({ username }) => username),
        admins: room.admins.flatMap(({ username }) => username),
        membersMicState: room.membersMicState,
        joiner: username,
      });
    }
  );

  socket.on(
    "remove-member",
    async ({ admin, member, socketRoomId, mainRoomId }, callback) => {
      try {
        // Check if the admin is really the admin
        const room = await Room.findOne({ mainRoomId }).populate("admins");

        // Currently there can only be one admin per room, so this works
        if (room.admins[0].username !== admin) {
          callback({ error: { message: "only admins can remove a member" } });
          return;
        }
        if (!usernameToSocketId[socketRoomId][member]) {
          await assignSocket(usernameToSocketId, socketRoomId, member);
        }
        io.to(usernameToSocketId[socketRoomId][member]).emit("exit", { admin });
      } catch (error) {
        console.error(error);
        callback({ error: { message: "server error" } });
      }
    }
  );

  socket.on("newVideoUrl", (data) => {
    socket.to(data.socketRoomId).emit("transmit-new-video-url", {
      videoUrl: data.videoUrl,
      videoId: data.videoId,
      startTime: data.startTime,
    });
  });

  socket.on("pause-video", ({ socketRoomId }) => {
    socket.to(socketRoomId).emit("server-pause-video", { tap: "tap" });
  });
  socket.on("play-video", ({ socketRoomId, curTimestamp }) => {
    socket.to(socketRoomId).emit("server-play-video", { curTimestamp });
  });

  socket.on(
    "req-timestamp",
    async ({ socketRoom, admin, username, execute }) => {
      if (!usernameToSocketId[socketRoom][admin]) {
        await assignSocket(usernameToSocketId, socketRoom, admin);
      }
      io.to(usernameToSocketId[socketRoom][admin]).emit("get-timestamp", {
        requester: username,
        execute,
      });
    }
  );

  socket.on("send-playback-rate", ({ speed, socketRoomId }) => {
    socket.to(socketRoomId).emit("receive-playback-rate", { speed });
  });

  socket.on(
    "mic-on-off",
    async ({ username, socketRoomId, roomId, status }) => {
      try {
        socket.to(socketRoomId).emit("mic-on-off-event", { username, status });
        const room = await Room.findOne({ mainRoomId: roomId });
        room.membersMicState[username] = status;
        room.markModified("membersMicState");
        await room.save();
      } catch (error) {
        console.error(error);
      }
    }
  );
  socket.on("error", (error) => {
    console.error("Socket error:", error);
  });
  socket.on("disconnect", (e) => {
    console.log("A user disconnected", { e });
  });
});

server.listen(process.env.PORT, () => {
  console.log("listening on *:", process.env.PORT);
});

app.get("/clients", (req, res) => {
  const connectedClientsCount = io.sockets.sockets.size;
  console.log("Sent clients");
  res.json({ connectedClients: connectedClientsCount });
});
