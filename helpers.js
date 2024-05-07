import { Room } from "./model/Room.js";
import { User } from "./model/User.js";
import jwt from "jsonwebtoken";
import axios from "axios";
import redis from "./lib/databases/redis.js";
import { roomToAdmin, usernameToSocketId } from "./index.js";

// To authenticate jwt token
export const authenticateToken = async (req, res, next, setCsp = false) => {
  const token = req.cookies.accessToken;
  if (setCsp) {
    res.setHeader(
      "Content-Security-Policy",
      `script-src '${process.env.FRONTENDURL}'`
    );
  }
  if (!token) {
    console.log("Token not received");
    return res.status(401).json({ msg: "No token provided" });
  }
  const secret = process.env.ACCESS_TOKEN_SECRET;
  if (!secret) {
    throw new Error("ACCESS_TOKEN_SECRET is not set");
  }
  try {
    const user = await jwt.verify(token, secret);
    // Check if the payload returned is correct
    if (!(typeof user === "object" && "name" in user)) {
      throw new Error("Invalid token");
    }
    req.user = user;
    next();
  } catch (error) {
    console.log("Invalid token");
    return res.status(403).json({ msg: "Invalid token" });
  }
};

export const checkTokenAndSetUserSocketId = async (token, socketId) => {
  const secret = process.env.ACCESS_TOKEN_SECRET;
  if (!secret) {
    throw new Error("ACCESS_TOKEN_SECRET is not set");
  }
  try {
    const payload = await jwt.verify(token, secret);
    if (typeof payload === "object" && "name" in payload) {
      const user = await User.findOneAndUpdate(
        { username: payload.name },
        { socketId: socketId }
      );

      if (!user) {
        return false;
      }

      await redis.hset(`user:${user.username}`, "socketId", socketId);
      return user.username;
    }
    return false;
  } catch (error) {
    console.error(error);
    return false;
  }
};

// This function is used to generate room id
export const generateRandomRoomID = async () => {
  try {
    const dictionary1 = [
      "cat",
      "dog",
      "sun",
      "moon",
      "book",
      "rain",
      "tree",
      "bird",
      "fish",
      "star",
    ];

    const dictionary2 = [
      "frog",
      "rose",
      "fire",
      "lake",
      "wind",
      "leaf",
      "snow",
      "song",
      "pear",
      "lamp",
    ];
    const dictionary3 = [
      "gold",
      "note",
      "pink",
      "blue",
      "cloud",
      "ship",
      "mint",
      "rosebud",
      "rock",
      "jump",
    ];

    const randomIndex1 = Math.floor(Math.random() * dictionary1.length);
    const randomIndex2 = Math.floor(Math.random() * dictionary2.length);
    const randomIndex3 = Math.floor(Math.random() * dictionary3.length);

    const word1 = dictionary1[randomIndex1];
    const word2 = dictionary2[randomIndex2];
    const word3 = dictionary3[randomIndex3];

    // concatenate the words with hyphens or any other separator
    const roomId = `${word1}-${word2}-${word3}`;
    // Check if the roomId already exists in the database
    const roomExists = await redis.exists(`room:${roomId}`);
    if (roomExists === 1) {
      return await generateRandomRoomID();
    }
    return roomId;
  } catch (error) {
    console.error(error);
  }
};

export const removeUserFromRoom = async (mainRoomId, memberToRemove) => {
  try {
    const updatedRoom = await Room.findOneAndUpdate(
      { mainRoomId },
      {
        $pull: { members: memberToRemove, admins: memberToRemove },
        $unset: { [`membersMicState.${memberToRemove}`]: "" },
      },
      { new: true }
    );

    // Check if any document was updated in the members array
    // If document was not updated, that means no member with such username exists
    if (!updatedRoom) {
      throw new Error("No such member exists in the room");
    }

    //  If the members array is empty, delete the room from DB, and send a request to sfu server to delete the mediasoup router associated with the room
    if (updatedRoom.members.length === 0) {
      // Send a request to sfu server Delete the mediasoup router associated with the room
      await axios.delete(
        `${process.env.SFU_SERVER_URL}/router/delete/${updatedRoom.socketRoomId}`,
        {
          data: {
            secret: process.env.SFU_SERVER_SECRET,
          },
        }
      );

      // delete the room
      await Room.deleteOne({ mainRoomId });
      await redis.del(`room:${mainRoomId}`);
      delete roomToAdmin[mainRoomId];
      return {
        msg: "user removed from room successfully and room deleted due to no members",
      };
    }

    // If there exists members in the room, and the user which was removed now was an admin, and if the admin array is empty, push the first user of the members array in the admin array
    if (updatedRoom.admins.length === 0) {
      updatedRoom.admins.push(updatedRoom.members[0]);
      await updatedRoom.save();
      roomToAdmin[updatedRoom.mainRoomId] = [updatedRoom.members[0]];
      await redis.hset(
        `room:${updatedRoom.mainRoomId}`,
        "admins",
        JSON.stringify([updatedRoom.members[0]]),
        "members",
        JSON.stringify(updatedRoom.members),
        "membersMicState",
        JSON.stringify(updatedRoom.membersMicState)
      );
      return {
        msg: `user removed from room successfully, new admin = ${updatedRoom.admins[0]}`,
      };
    }

    // Set cache
    await redis.hset(
      `room:${updatedRoom.mainRoomId}`,
      "admins",
      JSON.stringify(updatedRoom.admins),
      "members",
      JSON.stringify(updatedRoom.members),
      "membersMicState",
      JSON.stringify(updatedRoom.membersMicState)
    );

    return { msg: "user removed from room successfully" };
  } catch (error) {
    console.log(error);
    throw error;
  }
};

export const deleteRoomIfNoMembers = async (mainRoomId) => {
  try {
    // Find the room with the specified mainRoomId and check if it has 0 members
    const room = await Room.findOneAndDelete({
      mainRoomId,
      members: { $size: 0 }, // Check if 'members' array has size 0
    });
    if (room) {
      await redis.del(`room:${room.mainRoomId}`);
      delete roomToAdmin[room.mainRoomId];
    }
  } catch (error) {
    console.error(error);
  }
};

export const assignSocket = async (usernameToSocket, socketRoom, username) => {
  console.log("assignsocket was called");
  const user =
    (await redis.hgetall(`user:${username}`)) ||
    (await User.findOne({ username }));
  const userSocketId = user.socketId;
  if (usernameToSocket[socketRoom]) {
    usernameToSocket[socketRoom][username] = userSocketId;
  } else {
    usernameToSocket[socketRoom] = {};
    usernameToSocket[socketRoom][username] = userSocketId;
  }
};

export const checkUserSocketId = (
  usernameToSocketId,
  socketRoomId,
  username,
  socketId
) => {
  if (!usernameToSocketId[socketRoomId]) {
    usernameToSocketId[socketRoomId] = {};
  }
  if (!usernameToSocketId[socketRoomId][username]) {
    assignSocket(usernameToSocketId, socketRoomId, username);
  }
  if (usernameToSocketId[socketRoomId][username] !== socketId) {
    return false;
  }
  return true;
};

export const validateCredentials = (email, password, username) => {
  const validationResult = createUserSchema.validate({
    email,
    password,
    username,
  });
  if (validationResult.error) {
    return false;
  }
  return true;
};

export const checkIfAdmin = async (mainRoomId, username) => {
  if (!roomToAdmin[mainRoomId]) {
    const redisRoom = await redis.hgetall(`room:${mainRoomId}`);
    if (Object.keys(redisRoom).length === 0) {
      const room = await Room.findOne({ mainRoomId });
      if (!room) return false;
      roomToAdmin[mainRoomId] = room.admins;
    } else {
      roomToAdmin[mainRoomId] = JSON.parse(redisRoom.admins);
    }
  }
  return roomToAdmin[mainRoomId].includes(username);
};
