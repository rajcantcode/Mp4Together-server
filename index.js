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
  removeUserFromRoom,
  getWithTimeout,
} from "./helpers.js";

import redis from "./lib/databases/redis.js";
import connectToMongoose from "./lib/databases/mongo.js";
import { deleteOldDocuments } from "./controller/Auth.js";
import { User } from "./model/User.js";

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
  let socketUser, socketUserRoom, socketUserMainRoom, socketUserId;
  const cookies = socket.handshake.headers.cookie;
  const { mainRoomId, socketRoomId } = socket.handshake.query;
  const token = cookies?.split("accessToken=")[1].split(";")[0];
  if (!token) {
    socket.disconnect();
    return;
  }
  // returns username if token is valid, else returns false
  const isValidToken = await checkTokenAndSetUserSocketId(
    token,
    socket.id,
    mainRoomId
  );
  if (!isValidToken) {
    socket.disconnect();
    return;
  }
  tempUsernameToSocketId[isValidToken] = socket.id;
  socketUserMainRoom = mainRoomId;
  socketUserId = socket.id;

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
    socketUser = username;
    socketUserRoom = room;
  });

  // Listen for messages
  socket.on("sent-message", async ({ room, username, msgObj }) => {
    if (
      username !== socketUser ||
      room !== socketUserRoom ||
      socket.id !== socketUserId
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
          username !== socketUser ||
          socketRoomId !== socketUserRoom ||
          socketUserId !== socket.id ||
          mainRoomId !== socketUserMainRoom
        ) {
          socket.disconnect();
          return;
        }
        const msgObj = {
          type: "notification",
          message: `${username} left the room`,
        };

        let room = await getWithTimeout(`room:${mainRoomId}`);
        // hgetAll returns an empty object if the hash does not exist
        if (Object.keys(room).length === 0) {
          room = await Room.findOne({ mainRoomId: mainRoomId });
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
    async ({
      timestamp,
      socketRoom,
      username,
      admin,
      mainRoomId,
      execute,
      t,
    }) => {
      if (
        socketRoom !== socketUserRoom ||
        mainRoomId !== socketUserMainRoom ||
        admin !== socketUser ||
        socket.id !== socketUserId ||
        !(await checkIfAdmin(mainRoomId, admin))
      ) {
        socket.disconnect();
        return;
      }
      if (
        !usernameToSocketId[socketRoom] ||
        !usernameToSocketId[socketRoom][username]
      ) {
        await assignSocket(
          usernameToSocketId,
          socketRoom,
          username,
          mainRoomId
        );
      }
      io.to(usernameToSocketId[socketRoom][username]).emit("timestamp", {
        timestamp,
        execute,
        t,
      });
      if (execute) {
        if (
          !usernameToSocketId[socketRoom] ||
          !usernameToSocketId[socketRoom][admin]
        ) {
          await assignSocket(usernameToSocketId, socketRoom, admin, mainRoomId);
        }
        io.to(usernameToSocketId[socketRoom][admin]).emit("received-timestamp");
      }
    }
  );

  // Listen when user joins the room
  socket.on(
    "join-room",
    async ({ room: socketRoom, username, mainRoomId, admin }) => {
      try {
        if (
          socketRoom !== socketUserRoom ||
          mainRoomId !== socketUserMainRoom ||
          username !== socketUser ||
          socket.id !== socketUserId
        ) {
          socket.disconnect();
          return;
        }
        const msgObj = {
          type: "notification",
          message: `${username} joined the room`,
        };

        let room = await getWithTimeout(`room:${mainRoomId}`);
        if (Object.keys(room).length === 0) {
          room = await Room.findOne({ mainRoomId });
        }
        if (
          !usernameToSocketId[socketRoom] ||
          !usernameToSocketId[socketRoom][admin]
        ) {
          await assignSocket(usernameToSocketId, socketRoom, admin, mainRoomId);
        }
        if (
          !usernameToSocketId[socketRoom] ||
          !usernameToSocketId[socketRoom][username]
        ) {
          await assignSocket(
            usernameToSocketId,
            socketRoom,
            username,
            mainRoomId
          );
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
      } catch (error) {
        console.error(error);
      }
    }
  );

  socket.on(
    "remove-member",
    async ({ admin, member, socketRoomId, mainRoomId }, callback) => {
      try {
        if (
          socketRoomId !== socketUserRoom ||
          mainRoomId !== socketUserMainRoom ||
          admin !== socketUser ||
          socket.id !== socketUserId
        ) {
          socket.disconnect();
          return;
        }
        // Check if the admin is really the admin
        if (!(await checkIfAdmin(mainRoomId, admin))) {
          callback({ error: { message: "only admins can remove a member" } });
          return;
        }

        if (
          !usernameToSocketId[socketRoomId] ||
          !usernameToSocketId[socketRoomId][member]
        ) {
          await assignSocket(
            usernameToSocketId,
            socketRoomId,
            member,
            mainRoomId
          );
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
      t,
    }) => {
      if (
        socketRoomId !== socketUserRoom ||
        mainRoomId !== socketUserMainRoom ||
        username !== socketUser ||
        socket.id !== socketUserId ||
        !(await checkIfAdmin(mainRoomId, username))
      ) {
        socket.disconnect();
        return;
      }
      socket.to(socketRoomId).emit("transmit-new-video-url", {
        videoUrl: videoUrl,
        videoId: videoId,
        startTime: startTime,
        t,
      });
    }
  );

  socket.on(
    "pause-video",
    async ({ socketRoomId, username: admin, mainRoomId }) => {
      if (
        socketRoomId !== socketUserRoom ||
        mainRoomId !== socketUserMainRoom ||
        admin !== socketUser ||
        socket.id !== socketUserId ||
        !(await checkIfAdmin(mainRoomId, admin))
      ) {
        socket.disconnect();
        return;
      }

      socket.to(socketRoomId).emit("server-pause-video", { tap: "tap" });
    }
  );
  socket.on(
    "play-video",
    async ({ socketRoomId, curTimestamp, mainRoomId, username, t }) => {
      if (
        socketRoomId !== socketUserRoom ||
        mainRoomId !== socketUserMainRoom ||
        username !== socketUser ||
        socket.id !== socketUserId ||
        !(await checkIfAdmin(mainRoomId, username))
      ) {
        return;
      }
      socket.to(socketRoomId).emit("server-play-video", { curTimestamp, t });
    }
  );

  socket.on(
    "req-timestamp",
    async ({ socketRoom, admin, username, execute, mainRoomId }) => {
      if (
        socketRoom !== socketUserRoom ||
        mainRoomId !== socketUserMainRoom ||
        username !== socketUser ||
        socket.id !== socketUserId ||
        !(await checkIfAdmin(mainRoomId, admin))
      ) {
        return;
      }
      if (
        !usernameToSocketId[socketRoom] ||
        !usernameToSocketId[socketRoom][admin]
      ) {
        await assignSocket(usernameToSocketId, socketRoom, admin, mainRoomId);
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
        socketRoomId !== socketUserRoom ||
        mainRoomId !== socketUserMainRoom ||
        username !== socketUser ||
        socket.id !== socketUserId ||
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
        if (admin) {
          if (
            socketRoomId !== socketUserRoom ||
            roomId !== socketUserMainRoom ||
            admin !== socketUser ||
            socket.id !== socketUserId ||
            !(await checkIfAdmin(roomId, admin))
          ) {
            return;
          }
        }

        if (
          !admin &&
          (socketRoomId !== socketUserRoom ||
            roomId !== socketUserMainRoom ||
            username !== socketUser ||
            socket.id !== socketUserId)
        ) {
          return;
        }
        socket.to(socketRoomId).emit("mic-on-off-event", { username, status });
        const room = await Room.findOneAndUpdate(
          { mainRoomId: roomId },
          { $set: { [`membersMicState.${username}`]: status } },
          {
            new: true,
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

  // Sent by the admin to let other participants in the room to connect to the peer server
  socket.on("create-peer-conn", async (data) => {
    if (!checkIfAdmin(socketUserMainRoom, socketUser)) return;
    if (data && data.joiner) {
      const joiner = data.joiner;
      if (
        !usernameToSocketId[socketUserRoom] ||
        !usernameToSocketId[socketUserRoom][joiner]
      ) {
        await assignSocket(
          usernameToSocketId,
          socketUserRoom,
          joiner,
          socketUserMainRoom
        );
      }
      io.to(usernameToSocketId[socketUserRoom][joiner]).emit(
        "conn-peer-server"
      );
    } else {
      socket.to(socketUserRoom).emit("conn-peer-server");
    }
  });
  // Sent by the participants, when they successfully connect to the peer server
  socket.on("conn-succ", () => {
    // This event informs admin to call the user whose connected successfully to the peerjs server
    // This works because currently only one admin is allowed in a room
    const admin = roomToAdmin[socketUserMainRoom][0];
    io.to(usernameToSocketId[socketUserRoom][admin]).emit("create-call", {
      callee: socketUser,
    });
  });
  // Sent by admin when video streaming is stopped, so other people can close their connections
  socket.on("dest-peer", async (data, cb) => {
    if (!checkIfAdmin(socketUserMainRoom, socketUser)) return;
    if (data && data.peer) {
      if (
        !usernameToSocketId[socketUserRoom] ||
        !usernameToSocketId[socketUserRoom][data.peer]
      ) {
        await assignSocket(
          usernameToSocketId,
          socketUserRoom,
          data.peer,
          socketUserMainRoom
        );
      }
      io.timeout(4000)
        .to(usernameToSocketId[socketUserRoom][data.peer])
        .emit("dest-peer-conn", {}, (data) => {
          // if (data.status === "success") {
          //   cb({ status: data.status });
          // }
          cb({ status: "success" });
        });
      return;
    }
    socket.to(socketUserRoom).emit("dest-peer-conn");
  });
  socket.on("error", (error) => {
    console.error("Socket error:", error);
  });
  socket.on("disconnect", async (reason) => {
    try {
      // "transport close" is the reason when the user closes the tab
      if (reason === "transport close") {
        // Perform exit room for that socket user
        // Check if the user was admin
        if (roomToAdmin[socketUserMainRoom][0] === socketUser) {
          socket.to(socketUserRoom).emit("dest-peer-conn");
        }
        const { msg, roomObjId } = await removeUserFromRoom(
          socketUserMainRoom,
          socketUser
        );

        const user = await User.findOneAndUpdate(
          { username: socketUser },
          {
            $pull: {
              roomIds: socketUserMainRoom,
              rooms: roomObjId,
              socketIds: { room: socketUserMainRoom },
            },
          },
          { new: true }
        );

        await redis.hdel(
          `${user.guest ? `guest:${user.username}` : `user:${user.username}`}`,
          "roomIds",
          "socketIds"
        );
      }
      const msgObj = {
        type: "notification",
        message: `${socketUser} left the room`,
      };

      let room = await getWithTimeout(`room:${socketUserMainRoom}`);
      if (Object.keys(room).length === 0) {
        room = await Room.findOne({ mainRoomId: socketUserMainRoom });
      }
      if (room) {
        const response = room._id
          ? {
              msgObj,
              members: room.members,
              admins: room.admins,
              membersMicState: room.membersMicState,
              leaver: socketUser,
            }
          : {
              msgObj,
              members: JSON.parse(room.members),
              admins: JSON.parse(room.admins),
              membersMicState: JSON.parse(room.membersMicState),
              leaver: socketUser,
            };
        socket.to(socketUserRoom).emit("exit-msg", response);
      } else {
        socket.to(socketUserRoom).emit("exit-msg", {
          msgObj,
        });
      }
      socket.leave(socketUserRoom);
    } catch (error) {
      console.error(error);
    }
  });

  socket.emit("ready");
});

server.listen(process.env.PORT, () => {
  console.log("listening on *:", process.env.PORT);
});
