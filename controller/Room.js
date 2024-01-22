// Inserts room info in database
import { generateRandomRoomID, removeUserFromRoom } from "../helpers.js";
import { User } from "../model/User.js";
import { Room } from "../model/Room.js";
import { nanoid } from "nanoid";
import axios, { AxiosError } from "axios";
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
    });
    await newRoom.save();

    // Also save the roomId and room in User collection in DB
    user.roomId = roomId;
    user.room = newRoom._id;
    await user.save();

    res.status(200).json({
      roomId: user.roomId,
      socketRoomId: socketRoomId,
      members: [user.username],
      admins: [user.username],
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
      });
      return;
    }

    // Update the members array of the room collection
    room.members.push(user._id);
    await room.save();
    const updatedRoom = await Room.findOne({ mainRoomId })
      .populate("members", "username")
      .populate("admins", "username")
      .exec();

    // Send roomId and socketRoomId in the response
    res.status(200).json({
      roomId: updatedRoom.mainRoomId,
      socketRoomId: updatedRoom.socketRoomId,
      members: updatedRoom.members.flatMap(({ username }) => username),
      admins: updatedRoom.admins.flatMap(({ username }) => username),
      username: user.username,
      email: user.email,
      videoUrl: updatedRoom.videoUrl,
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
    console.log(mainRoomId);

    // If the operation is successful, the response msg to be sent to the user will be returned by "removeUserFromRoom" function
    const msg = await removeUserFromRoom(mainRoomId, user._id);
    console.log(msg);

    // Set the roomId property of the user to ""
    // const user = await User.findOne({ username: memberToRemove });
    user.roomId = "";
    user.room = null;
    user.socketId = "";
    await user.save();

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
      return res.status(200).json({
        msg: "Video url saved successfully",
      });
    }

    // Check if request is sent by admin
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
