import { Room } from "./model/Room.js";
import { User } from "./model/User.js";
import jwt from "jsonwebtoken";
import axios from "axios";
import redis from "./lib/databases/redis.js";

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
      const user = await User.findOne({ username: payload.name });
      if (!user) {
        return false;
      }
      user.socketId = socketId;
      await user.save();
      await redis.hset(`user:${user.username}`, "socketId", socketId);
      return true;
    }
    return false;
  } catch (error) {
    console.error(error);
    return false;
  }
};

// This function is used to generate room id
export const generateRandomRoomID = async () => {
  const dictionary = [
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

  const randomIndex1 = Math.floor(Math.random() * dictionary.length);
  const randomIndex2 = Math.floor(Math.random() * dictionary.length);
  const randomIndex3 = Math.floor(Math.random() * dictionary.length);

  const word1 = dictionary[randomIndex1];
  const word2 = dictionary[randomIndex2];
  const word3 = dictionary[randomIndex3];

  // You can concatenate the words with hyphens or any other separator
  const roomId = `${word1}-${word2}-${word3}`;
  return roomId;
};

export const removeUserFromRoom = async (
  mainRoomId,
  userId,
  memberToRemove
) => {
  try {
    // Remove the user from the members array using userId
    const membersUpdateResult = await Room.updateOne(
      { mainRoomId },
      {
        $pull: { members: userId },
        $unset: { [`membersMicState.${memberToRemove}`]: "" },
      }
    );

    // Check if any document was updated in the members array
    // If document was not updated, that means no member with such username exists
    if (!membersUpdateResult.modifiedCount > 0) {
      throw new Error("No such member exists in the room");
    }

    // Remove the username from the admins array
    const adminsUpdateResult = await Room.updateOne(
      { mainRoomId },
      { $pull: { admins: userId } }
    );

    // After removing user, if the members array is empty, delete the room from DB
    // Fetch the updated room to check if the members array is empty
    const updatedRoom = await Room.findOne({ mainRoomId })
      .populate("members", "username")
      .populate("admins", "username")
      .exec();
    if (updatedRoom && updatedRoom.members.length === 0) {
      // Send a request to sfu server Delete the mediasoup router associated with the room
      await axios.delete(
        `${process.env.SFU_SERVER_URL}/router/delete/${updatedRoom.socketRoomId}`,
        {
          data: {
            secret: process.env.SFU_SERVER_SECRET,
          },
        }
      );

      // If the members array is empty, delete the room
      await Room.deleteOne({ mainRoomId });
      await redis.del(`room:${mainRoomId}`);
      return {
        msg: "user removed from room successfully and room deleted due to no members",
      };
    }

    // If there exists members in the room, and the user which was removed now was an admin, and if the admin array is empty, push the first user of the members array in the admin array
    if (updatedRoom && updatedRoom.admins.length === 0) {
      updatedRoom.admins.push(updatedRoom.members[0]._id);
      await updatedRoom.save();
      await redis.hset(
        `room:${updatedRoom.mainRoomId}`,
        "admins",
        JSON.stringify([updatedRoom.members[0].username]),
        "members",
        JSON.stringify(updatedRoom.members.flatMap(({ username }) => username))
      );
      return {
        msg: `user removed from room successfully, new admin = ${updatedRoom.admins[0]}`,
      };
    }

    // Set cache
    await redis.hset(
      `room:${updatedRoom.mainRoomId}`,
      "admins",
      JSON.stringify(updatedRoom.admins.flatMap(({ username }) => username)),
      "members",
      JSON.stringify(updatedRoom.members.flatMap(({ username }) => username))
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

export const validateCredentials = (email, password, username) => {
  const validationResult = createUserSchema.validate({
    email,
    password,
    username,
  });
  // Regular expression pattern for validating email addresses.
  const emailPattern = /^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,4}$/;

  // This check is used for checking if user has entered all details correctly
  if (
    emailPattern.test(email) &&
    password.length >= 8 &&
    username.length >= 4
  ) {
    return true;
  }

  return false;
};
