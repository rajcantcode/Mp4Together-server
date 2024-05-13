import dotenv from "dotenv";
dotenv.config();
import express from "express";
import http from "http";
import cors from "cors";
import bodyParser from "body-parser";
import cookieParser from "cookie-parser";
import { rateLimit } from "express-rate-limit";
import { Room } from "./model/Room.js";
import { Server } from "socket.io";
import helmet from "helmet";
import cron from "node-cron";

// Import routers
import authRouter from "./routes/Auth.js";
import roomRouter from "./routes/Room.js";
import userRouter from "./routes/User.js";
// Helper functions
import {
  assignSocket,
  checkTokenAndSetUserSocketId,
  authenticateToken,
  checkUserSocketId,
  checkIfAdmin,
} from "./helpers.js";

import redis from "./lib/databases/redis.js";
import connectToMongoose from "./lib/databases/mongo.js";
import { deleteOldDocuments } from "./controller/Auth.js";

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
app.use("/user", authenticateToken, userRouter);

connectToMongoose().catch((err) => console.error(err));
cron.schedule("*/10 * * * *", deleteOldDocuments);
export const usernameToSocketId = {};
const tempUsernameToSocketId = {};
export const roomToAdmin = {};
// Socket code
io.on("connection", async (socket) => {
  // Authenticate socket connection
  let socketUser;
  let socketUserRoom;
  const cookies = socket.handshake.headers.cookie;
  const token = cookies?.split("accessToken=")[1].split(";")[0];
  if (!token) {
    socket.disconnect();
    return;
  }
  // returns username if token is valid, else returns false
  const isValidToken = await checkTokenAndSetUserSocketId(token, socket.id);
  if (!isValidToken) {
    socket.disconnect();
    return;
  }
  tempUsernameToSocketId[isValidToken] = socket.id;
  socket.emit("ready");

  // Join a room
  socket.on("join", async ({ room, username, guest }) => {
    if (socket.id !== tempUsernameToSocketId[username]) {
      socket.disconnect();
      return;
    }
    // delete tempUsernameToSocketId[username];
    socket.join(room);
    if (usernameToSocketId[room]) {
      usernameToSocketId[room][username] = socket.id;
    } else {
      usernameToSocketId[room] = {};
      usernameToSocketId[room][username] = socket.id;
    }
    await redis.hset(
      `${guest ? `guest:${username}` : `user:${username}`}`,
      "socketId",
      socket.id
    );
    socketUser = username;
    socketUserRoom = room;
  });

  // Listen for messages
  socket.on("sent-message", async ({ room, username, msgObj }) => {
    if (
      !(await checkUserSocketId(usernameToSocketId, room, username, socket.id))
    ) {
      socket.disconnect();
      return;
    }
    socket.to(room).emit("receive-message", { ...msgObj });
  });

  // Listen when user exits the room
  socket.on(
    "exit-room",
    async ({ username, mainRoomId, room: socketRoomId }) => {
      try {
        if (
          !(await checkUserSocketId(
            usernameToSocketId,
            socketRoomId,
            username,
            socket.id
          ))
        ) {
          socket.disconnect();
          return;
        }
        const msgObj = {
          type: "notification",
          message: `${username} left the room`,
        };

        let room = await redis.hgetall(`room:${mainRoomId}`);
        // hgetAll returns an empty array if the hash does not exist
        if (Object.keys(room).length === 0) {
          room = await Room.findOne({ mainRoomId: mainRoomId });
        }

        if (usernameToSocketId[socketRoomId][username]) {
          delete usernameToSocketId[socketRoomId][username];
        }
        if (Object.keys(usernameToSocketId[socketRoomId]).length === 0) {
          delete usernameToSocketId[socketRoomId];
        }

        // Send the message to other users, that a user exited the room
        if (room) {
          const response = room._id
            ? {
                msgObj,
                members: room.members,
                admins: room.admins,
                membersMicState: room.membersMicState,
                leaver: username,
              }
            : {
                msgObj,
                members: JSON.parse(room.members),
                admins: JSON.parse(room.admins),
                membersMicState: JSON.parse(room.membersMicState),
                leaver: username,
              };
          socket.to(socketRoomId).emit("exit-msg", response);
        } else {
          socket.to(socketRoomId).emit("exit-msg", {
            msgObj,
          });
        }
        socket.leave(socketRoomId);
      } catch (error) {
        console.error(error);
      }
    }
  );

  socket.on(
    "send-timestamp",
    async ({ timestamp, socketRoom, username, admin, mainRoomId, execute }) => {
      if (
        !(await checkUserSocketId(
          usernameToSocketId,
          socketRoom,
          admin,
          socket.id
        )) ||
        !(await checkIfAdmin(mainRoomId, admin))
      ) {
        socket.disconnect();
        return;
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
      console.log(`received join-room event from ${username} in ${socketRoom}`);
      if (
        !(await checkUserSocketId(
          usernameToSocketId,
          socketRoom,
          username,
          socket.id
        ))
      ) {
        socket.disconnect();
        return;
      }
      const msgObj = {
        type: "notification",
        message: `${username} joined the room`,
      };

      let room = await redis.hgetall(`room:${mainRoomId}`);
      if (Object.keys(room).length === 0) {
        room = await Room.findOne({ mainRoomId });
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

      // Checking if the room is obtained from database or cache
      const response = room._id
        ? {
            msgObj,
            members: room.members,
            admins: room.admins,
            membersMicState: room.membersMicState,
            joiner: username,
          }
        : {
            msgObj,
            members: JSON.parse(room.members),
            admins: JSON.parse(room.admins),
            membersMicState: JSON.parse(room.membersMicState),
            joiner: username,
          };
      // Send the message to other users, that a user joined the room
      socket.to(socketRoom).emit("join-msg", response);
    }
  );

  socket.on(
    "remove-member",
    async ({ admin, member, socketRoomId, mainRoomId }, callback) => {
      try {
        if (
          !(await checkUserSocketId(
            usernameToSocketId,
            socketRoomId,
            admin,
            socket.id
          ))
        ) {
          socket.disconnect();
          return;
        }
        // Check if the admin is really the admin
        if (!(await checkIfAdmin(mainRoomId, admin))) {
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

  socket.on(
    "newVideoUrl",
    async ({
      socketRoomId,
      videoUrl,
      videoId,
      startTime,
      mainRoomId,
      username,
    }) => {
      if (
        !(await checkUserSocketId(
          usernameToSocketId,
          socketRoomId,
          username,
          socket.id
        )) ||
        !(await checkIfAdmin(mainRoomId, username))
      ) {
        return;
      }
      socket.to(socketRoomId).emit("transmit-new-video-url", {
        videoUrl: videoUrl,
        videoId: videoId,
        startTime: startTime,
      });
    }
  );

  socket.on(
    "pause-video",
    async ({ socketRoomId, username: admin, mainRoomId }) => {
      if (
        !(await checkUserSocketId(
          usernameToSocketId,
          socketRoomId,
          admin,
          socket.id
        )) ||
        !(await checkIfAdmin(mainRoomId, admin))
      ) {
        return;
      }

      socket.to(socketRoomId).emit("server-pause-video", { tap: "tap" });
    }
  );
  socket.on(
    "play-video",
    async ({ socketRoomId, curTimestamp, mainRoomId, username }) => {
      if (
        !(await checkUserSocketId(
          usernameToSocketId,
          socketRoomId,
          username,
          socket.id
        )) ||
        !(await checkIfAdmin(mainRoomId, username))
      ) {
        return;
      }
      socket.to(socketRoomId).emit("server-play-video", { curTimestamp });
    }
  );

  socket.on(
    "req-timestamp",
    async ({ socketRoom, admin, username, execute, mainRoomId }) => {
      if (
        !(await checkUserSocketId(
          usernameToSocketId,
          socketRoom,
          username,
          socket.id
        )) ||
        !(await checkIfAdmin(mainRoomId, admin))
      ) {
        return;
      }
      if (!usernameToSocketId[socketRoom][admin]) {
        await assignSocket(usernameToSocketId, socketRoom, admin);
      }
      io.to(usernameToSocketId[socketRoom][admin]).emit("get-timestamp", {
        requester: username,
        execute,
      });
    }
  );

  socket.on(
    "send-playback-rate",
    async ({ speed, socketRoomId, mainRoomId, username }) => {
      if (
        !(await checkUserSocketId(
          usernameToSocketId,
          socketRoomId,
          username,
          socket.id
        )) ||
        !(await checkIfAdmin(mainRoomId, username))
      ) {
        return;
      }
      socket.to(socketRoomId).emit("receive-playback-rate", { speed });
    }
  );

  socket.on(
    "mic-on-off",
    async ({ username, admin, socketRoomId, roomId, status }) => {
      try {
        if (
          admin &&
          !(await checkUserSocketId(
            usernameToSocketId,
            socketRoomId,
            admin,
            socket.id
          ))
        ) {
          return;
        }
        if (
          !admin &&
          !(await checkUserSocketId(
            usernameToSocketId,
            socketRoomId,
            username,
            socket.id
          ))
        ) {
          return;
        }
        socket.to(socketRoomId).emit("mic-on-off-event", { username, status });
        const room = await Room.findOneAndUpdate(
          { mainRoomId: roomId },
          { $set: { "membersMicState.$[username]": status } },
          {
            new: true,
            arrayFilters: [{ username: username }],
          }
        );
        await redis.hset(
          `room:${roomId}`,
          "membersMicState",
          JSON.stringify(room.membersMicState)
        );
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
    console.log(`${socketUser} disconnected`);
  });
});

app.get("/clients", async (req, res) => {
  const connectedClientsCount = io.sockets.sockets.size;
  console.log(io.sockets.sockets.keys());
  console.log("Sent clients");
  const socketRoom = req.query.room;
  const members = await io.in(socketRoom).fetchSockets();
  console.log("Printing members of room");
  console.log(members);
  members.forEach((member) => {
    console.log(member.id);
  });
  res.json({ connectedClients: connectedClientsCount });
});

server.listen(process.env.PORT, () => {
  console.log("listening on *:", process.env.PORT);
});
