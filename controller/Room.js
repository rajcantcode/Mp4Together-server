// Inserts room info in database
import { generateRandomRoomID, removeUserFromRoom } from "../helpers.js";
import { User } from "../model/User.js";
import { Room } from "../model/Room.js";
import { nanoid } from "nanoid";
import axios, { AxiosError } from "axios";
import redis from "../lib/databases/redis.js";
import { roomToAdmin, usernameToSocketId } from "../index.js";
import { youtube } from "@googleapis/youtube";
export const createRoom = async (req, res) => {
  try {
    // Get username from req, which is passed by middleware
    const username = req.user.name;

    // Generate roomId and save in the DB
    let roomId = await generateRandomRoomID();
    const socketRoomId = nanoid(8);
    const newRoom = new Room({
      mainRoomId: roomId,
      socketRoomId,
      members: [username],
      admins: [username],
      membersMicState: { [username]: false },
    });
    await newRoom.save();
    roomToAdmin[roomId] = [username];

    // Also save the roomId and room in User collection in DB
    const user = await User.findOneAndUpdate(
      { username },
      { $push: { roomIds: newRoom.mainRoomId, rooms: newRoom._id } },
      { new: true }
    );

    // Cache room and user
    // Removing room property, since we are going to separately cache room anyways
    const pipeline = redis.pipeline();
    const userToCache = {
      email: user.email,
      username: user.username,
      roomIds: JSON.stringify(user.roomIds),
      socketIds: JSON.stringify(user.socketIds),
    };
    pipeline.hset(
      `${user.guest ? `guest:${user.username}` : `user:${user.username}`}`,
      userToCache
    );

    const roomToCache = {
      mainRoomId: newRoom.mainRoomId,
      socketRoomId: newRoom.socketRoomId,
      videoUrl: newRoom.videoUrl,
      members: [user.username],
      admins: [user.username],
      membersMicState: newRoom.membersMicState,
    };
    pipeline.hset(`room:${newRoom.mainRoomId}`, {
      ...roomToCache,
      membersMicState: JSON.stringify(newRoom.membersMicState),
      members: JSON.stringify([user.username]),
      admins: JSON.stringify([user.username]),
    });
    await pipeline.exec();

    res.status(200).json({
      roomId: newRoom.mainRoomId,
      socketRoomId: newRoom.socketRoomId,
      members: [user.username],
      admins: [user.username],
      membersMicState: newRoom.membersMicState,
      guest: user.guest,
    });
  } catch (error) {
    console.error(error);
    res.status(501).json({ msg: "internal server error" });
  }
};

export const joinRoom = async (req, res) => {
  try {
    const mainRoomId = req.params.id;
    const username = req.user.name;

    // Find the room with the given roomId and add the user to the members array
    const room = await Room.findOneAndUpdate(
      { mainRoomId, members: { $ne: username } },
      {
        $push: { members: username },
        $set: { [`membersMicState.${username}`]: false },
      },
      { new: true }
    );
    if (!room) {
      // If no room is found, return an error response
      return res.status(404).json({ msg: "No such room exists" });
    }

    // Assign the found room's roomId to user and save it in DB
    const user = await User.findOneAndUpdate(
      { username },
      { $push: { roomIds: room.mainRoomId, rooms: room._id } },
      { new: true }
    );

    // Cache user
    // Removing room property, since we are going to separately cache room anyways
    const { room: userRoom, ...userToCache } = user;
    const pipeline = redis.pipeline();
    pipeline.hset(
      `${user.guest ? `guest:${user.username}` : `user:${user.username}`}`,
      "roomIds",
      JSON.stringify(user.roomIds)
    );

    const roomObjToSend = {
      roomId: room.mainRoomId,
      socketRoomId: room.socketRoomId,
      members: room.members,
      admins: room.admins,
      videoUrl: room.videoUrl,
      membersMicState: room.membersMicState,
    };
    // Cache room
    pipeline.hset(`room:${room.mainRoomId}`, {
      mainRoomId: room.mainRoomId,
      socketRoomId: room.socketRoomId,
      videoUrl: room.videoUrl,
      members: JSON.stringify(roomObjToSend.members),
      admins: JSON.stringify(roomObjToSend.admins),
      membersMicState: JSON.stringify(roomObjToSend.membersMicState),
    });
    await pipeline.exec();
    // Send roomId and socketRoomId in the response
    res.status(200).json({
      username: user.username,
      email: user.email,
      guest: user.guest,
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
    // If the operation is successful, the response msg to be sent to the user will be returned by "removeUserFromRoom" function
    const { msg, roomObjId } = await removeUserFromRoom(
      mainRoomId,
      memberToRemove
    );

    const user = await User.findOneAndUpdate(
      { username: memberToRemove },
      {
        $pull: {
          roomIds: mainRoomId,
          rooms: roomObjId,
          socketIds: { room: mainRoomId },
        },
      },
      { new: true }
    );

    // Cache user
    await redis.hdel(
      `${user.guest ? `guest:${user.username}` : `user:${user.username}`}`,
      "roomIds",
      "socketIds"
    );

    res.status(200).json({ msg });
  } catch (error) {
    console.error(error);
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

      // If url is valid, verify if the user who sent request is an admin in the room, then save the url

      const room = await Room.findOneAndUpdate(
        { mainRoomId: roomId, admins: { $in: [username] } },
        { videoUrl: videoUrl },
        { new: true }
      );

      if (!room) {
        return res.status(403).json({
          msg: "Only admins are allowed to set video url or no such room exists",
        });
      }

      // Update room cache
      await redis.hset(`room:${room.mainRoomId}`, "videoUrl", videoUrl);

      return res.status(200).json({
        msg: "Video url saved successfully",
      });
    }
  } catch (error) {
    if (error instanceof AxiosError) {
      console.error(error);
      if (error.code === "ERR_BAD_REQUEST") {
        return res.status(404).json({ msg: "No such youtube video exists" });
      } else {
        return res.status(501).json({ msg: "internal server error" });
      }
    }
    return res.status(501).json({ msg: "internal server error" });
  }
};

const Youtube = process.env.YOUTUBE_API_KEY
  ? youtube({ version: "v3", auth: process.env.YOUTUBE_API_KEY })
  : null;
export const getVideoDetails = async (req, res) => {
  try {
    const query = req.query.q;
    if (typeof query !== "string") {
      return res.status(400).json({ msg: "Invalid query" });
    }
    if (!Youtube) {
      throw new Error("Youtube API key not set");
    }
    const cachedData = await redis.get(`yt:${query}`);
    if (cachedData) {
      res.set("Cache-Control", "public, max-age=3600");
      return res.status(200).json({ data: JSON.parse(cachedData) });
    }
    const response = await Youtube.search.list({
      part: ["snippet"],
      type: ["video"],
      fields:
        "items(id/videoId,snippet/title,snippet/thumbnails/default,snippet/channelTitle)",
      maxResults: 10,
      q: query,
    });
    const items = response.data.items;
    const videoDetails = items.map((item) => {
      return {
        channel: item.snippet?.channelTitle ?? "",
        name: item.snippet?.title ?? "",
        videoId: item?.id?.videoId ?? "",
        thumbnail: item.snippet?.thumbnails?.default?.url ?? "",
      };
    });
    res.set("Cache-Control", "public, max-age=3600");
    res.status(200).json({ data: videoDetails });
    await redis.setex(`yt:${query}`, 3600, JSON.stringify(videoDetails));
  } catch (error) {
    console.error(error);
    return res.status(501).json({ msg: "Internal server error" });
  }
};
