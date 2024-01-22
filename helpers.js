import { Room } from "./model/Room.js";
import { User } from "./model/User.js";
import jwt from "jsonwebtoken";

// To authenticate jwt token
export const authenticateToken = async (req, res, next) => {
  const token = req.cookies.accessToken;
  if (!token) {
    console.log("Token not received");
    return res.status(401).json({ msg: "No token provided" });
  }

  try {
    const user = await jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    req.user = user;
    next();
  } catch (error) {
    console.log("Invalid token");
    return res.status(403).json({ msg: "Invalid token" });
  }
};

export const authenticateSocketToken = async (token) => {
  try {
    const user = await jwt.verify(token, process.env.ACCESS_TOKEN_SECRET);
    return user;
  } catch (error) {
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

export const removeUserFromRoom = async (mainRoomId, userId) => {
  try {
    // Remove the user from the members array using userId
    const membersUpdateResult = await Room.updateOne(
      { mainRoomId },
      { $pull: { members: userId } }
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
    const updatedRoom = await Room.findOne({ mainRoomId });
    if (updatedRoom && updatedRoom.members.length === 0) {
      // If the members array is empty, delete the room
      await Room.deleteOne({ mainRoomId });
      return {
        msg: "user removed from room successfully and room deleted due to no members",
      };
    }

    // If there exists members in the room, and the user which was removed now was an admin, and if the admin array is empty, push the first user of the members array in the admin array
    if (updatedRoom && updatedRoom.admins.length === 0) {
      updatedRoom.admins.push(updatedRoom.members[0]);
      await updatedRoom.save();
      return {
        msg: `user removed from room successfully, new admin = ${updatedRoom.admins[0]}`,
      };
    }

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
  } catch (error) {
    console.error(error);
  }
};

export const assignSocket = async (usernameToSocket, socketRoom, username) => {
  const user = await User.findOne({ username });
  const userSocketId = user.socketId;
  if (usernameToSocket[socketRoom]) {
    usernameToSocket[socketRoom][username] = userSocketId;
  } else {
    usernameToSocket[socketRoom] = {};
    usernameToSocket[socketRoom][username] = userSocketId;
  }
};
export const validateCredentials = (email, password, username) => {
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
};
