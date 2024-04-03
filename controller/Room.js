// Inserts room info in database
import { generateRandomRoomID, removeUserFromRoom } from "../helpers.js";
import { User } from "../model/User.js";
import { Room } from "../model/Room.js";
import { nanoid } from "nanoid";
import axios, { AxiosError } from "axios";
import redis from "../lib/databases/redis.js";
export const createRoom = async (req, res) => {
  try {
    // Get username from req, which is passed by middleware
    const username = req.user.name;
    // Verify if such a user exists
    const user = await User.findOne({ username });

    if (!user) return res.status(404).json({ msg: "No such user exists" });

    // Check if the user already has a roomId, if so, remove the user from that room
    if (user.roomId !== "") {
      const room = await Room.findOne({ mainRoomId: user.roomId });
      if (room) {
        await removeUserFromRoom(room.mainRoomId, user._id);
      }
    }

    // Generate roomId and save in the DB
    let roomId = await generateRandomRoomID();
    const socketRoomId = nanoid(8);
    const newRoom = new Room({
      mainRoomId: roomId,
      socketRoomId,
      members: [user._id],
      admins: [user._id],
      membersMicState: { [user.username]: false },
    });
    await newRoom.save();

    // Also save the roomId and room in User collection in DB
    user.roomId = roomId;
    user.room = newRoom._id;
    await user.save();

    // Cache room and user
    // Removing room property, since we are going to separately cache room anyways
    const userToCache = {
      email: user.email,
      username: user.username,
      roomId: user.roomId,
      socketId: user.socketId,
    };
    await redis.hset(`user:${user.username}`, userToCache);

    const roomToCache = {
      mainRoomId: newRoom.mainRoomId,
      socketRoomId: newRoom.socketRoomId,
      videoUrl: newRoom.videoUrl,
      members: [user.username],
      admins: [user.username],
      membersMicState: newRoom.membersMicState,
    };
    await redis.hset(`room:${newRoom.mainRoomId}`, {
      ...roomToCache,
      membersMicState: JSON.stringify(newRoom.membersMicState),
      members: JSON.stringify([user.username]),
      admins: JSON.stringify([user.username]),
    });

    res.status(200).json({
      roomId: user.roomId,
      socketRoomId: socketRoomId,
      members: [user.username],
      admins: [user.username],
      membersMicState: newRoom.membersMicState,
    });
  } catch (error) {
    console.log("error at createRoom[POST], ", { error });
    res.status(501).json({ msg: "internal server error" });
  }
};

export const joinRoom = async (req, res) => {
  try {
    const mainRoomId = req.params.id;
    // Use Mongoose to find a room by roomId
    const room = await Room.findOne({ mainRoomId })
      .populate("members", "username")
      .populate("admins", "username")
      .exec();
    if (!room) {
      // If no room is found, return an error response
      console.log("Room not found");
      return res.status(404).json({ msg: "No such room exists" });
    }

    // If room is found
    // Find the user
    const username = req.user.name;
    const user = await User.findOne({ username });

    // Check if the user already has a roomId, if so, remove the user from that room
    if (user.roomId !== "" && user.roomId !== room.mainRoomId) {
      const room = await Room.findOne({ mainRoomId: user.roomId });
      if (room) {
        await removeUserFromRoom(room.mainRoomId, user._id);
      }
    }

    // Assign the found room's roomId to user and save it in DB
    user.roomId = room.mainRoomId;
    user.room = room._id;
    await user.save();

    // Cache user
    // Removing room property, since we are going to separately cache room anyways
    const { room: userRoom, ...userToCache } = user;
    await redis.hset(`user:${user.username}`, "roomId", room.mainRoomId);

    // Check if the user is already present in room, if present return the response
    const isUserInMembers = room.members.some(
      (member) => member.username === username
    );
    if (isUserInMembers) {
      // User is already a member in room
      res.status(200).json({
        roomId: room.mainRoomId,
        socketRoomId: room.socketRoomId,
        members: room.members.flatMap(({ username }) => username),
        admins: room.admins.flatMap(({ username }) => username),
        username: user.username,
        email: user.email,
        videoUrl: room.videoUrl,
        membersMicState: room.membersMicState,
      });
      return;
    }

    // Update the members array of the room collection
    room.members.push(user._id);
    room.membersMicState[user.username] = false;
    room.markModified("membersMicState");
    await room.save();

    const updatedRoom = await Room.findOne({ mainRoomId })
      .populate("members", "username")
      .populate("admins", "username")
      .exec();

    const roomObjToSend = {
      roomId: updatedRoom.mainRoomId,
      socketRoomId: updatedRoom.socketRoomId,
      members: updatedRoom.members.flatMap(({ username }) => username),
      admins: updatedRoom.admins.flatMap(({ username }) => username),
      videoUrl: updatedRoom.videoUrl,
      membersMicState: updatedRoom.membersMicState,
    };
    // Cache room
    await redis.hset(`room:${updatedRoom.mainRoomId}`, {
      mainRoomId: updatedRoom.mainRoomId,
      socketRoomId: updatedRoom.socketRoomId,
      videoUrl: updatedRoom.videoUrl,
      members: JSON.stringify(roomObjToSend.members),
      admins: JSON.stringify(roomObjToSend.admins),
      membersMicState: JSON.stringify(roomObjToSend.membersMicState),
    });
    // Send roomId and socketRoomId in the response
    res.status(200).json({
      username: user.username,
      email: user.email,
      ...roomObjToSend,
    });
    return;
  } catch (error) {
    // Handle any errors that occur during the process
    console.error('Error at "/joinRoom/:roomID[get]"', error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const exitRoom = async (req, res) => {
  try {
    // Remove the user from members array and admins array for the specific room
    const mainRoomId = req.params.id;
    const memberToRemove = req.user.name;
    const user = await User.findOne({ username: memberToRemove });

    // If the operation is successful, the response msg to be sent to the user will be returned by "removeUserFromRoom" function
    const msg = await removeUserFromRoom(mainRoomId, user._id, memberToRemove);

    // Set the roomId property of the user to ""
    // const user = await User.findOne({ username: memberToRemove });
    user.roomId = "";
    user.room = null;
    user.socketId = "";
    await user.save();

    // Cache user
    await redis.hdel(`user:${user.username}`, "roomId", "socketID");

    res.status(200).json({ msg });
  } catch (error) {
    console.log("Error at exitRoom[POST] ", error);
    if (error === "No such member exists in the room") {
      res.status(404).json({ msg: "No such member exists in the room" });
    } else {
      res.status(501).json({ msg: "Internal server error" });
    }
  }
};

export const saveUrl = async (req, res) => {
  try {
    const roomId = req.params.id;
    const videoUrl = req.query.videoUrl;
    const username = req.user.name;

    // Check if videoUrl provided
    if (videoUrl === "" || !videoUrl) {
      return res.status(400).json({ msg: "No video url provided" });
    }

    // Check if room exists
    const room = await Room.findOne({ mainRoomId: roomId })
      .populate("admins", "username")
      .exec();
    if (!room) {
      return res.status(404).json({ msg: "No such room exists" });
    }

    // Check if the sent url is valid
    const urlRegex = /^https:\/\/www\.youtube-nocookie\.com\/embed\/([^\/]+)$/;
    const match = videoUrl.match(urlRegex);
    if (!match) {
      return res.status(404).json({ msg: "Invalid url" });
    }
    if (match) {
      const videoId = match[1];
      await axios.get(
        `https://www.youtube.com/oembed?format=json&url=https://www.youtube.com/watch?v=${videoId}`
      );

      // If url is valid, verify if the user who sent request is an admin in the room
      const admin = room.admins.find(
        ({ username }) => username === req.user.name
      );
      if (!admin) {
        return res
          .status(403)
          .json({ msg: "Only admins are allowed to set video url" });
      }
      room.videoUrl = videoUrl;
      await room.save();

      // Update room cache
      await redis.hset(`room:${room.mainRoomId}`, "videoUrl", videoUrl);

      return res.status(200).json({
        msg: "Video url saved successfully",
      });
    }
  } catch (error) {
    if (error instanceof AxiosError) {
      if (error.code === "ERR_BAD_REQUEST") {
        return res.status(404).json({ msg: "No such youtube video exists" });
      } else {
        console.log("Error at saveUrl[POST] ", error);
        return res.status(501).json({ msg: "internal server error" });
      }
    }
    console.log("Error at saveUrl[POST] ", error);
    return res.status(501).json({ msg: "internal server error" });
  }
};
// Resolve exit room error
