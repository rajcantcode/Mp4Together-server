import { User } from "../model/User.js";
import redis from "../lib/databases/redis.js";
import Joi from "joi";
import jwt from "jsonwebtoken";
import { changeUsernameSchema } from "../lib/validators/UserSchema.js";

export const returnUser = async (req, res) => {
  try {
    // Get username from req, which is passed by "authenticateToken" middleware
    console.log("In returnUser");
    const username = req.user.name;
    console.log("finding ", username);
    // Verify if such a user exists
    // Check in redis cache
    let user = await redis.hgetall(`user:${username}`);
    // If not in cache, check in database
    if (Object.keys(user).length === 0) {
      user = await User.findOne({ username });
      if (!user) {
        return res.status(404).json({ msg: "User not found" });
      }

      // await redis.hset(`user:${username}`, {
      //   email: user.email,
      //   username: user.username,
      // });
      // await redis.expire(`user:${username}`, 3600 * 24 * 7);
      const pipeline = redis.pipeline();

      pipeline.hset(`user:${username}`, {
        email: user.email,
        username: user.username,
      });

      pipeline.expire(`user:${username}`, 3600 * 24 * 7);

      await pipeline.exec();
      return res
        .status(200)
        .json({ email: user.email, username: user.username });
    } else {
      console.log("User found, ", user);
      res.status(200).json({ email: user.email, username: user.username });
    }
  } catch (error) {
    console.error(`💥💥 Error at /user[GET] `, error);
    res.status(501).json({ msg: "Internal server error" });
  }
};

export const changeUsername = async (req, res) => {
  try {
    // Get username from req, which is passed by "authenticateToken" middleware
    const username = req.user.name;
    // Verify if such a user exists
    // const user = await User.findOne({ username });
    // if (!user) {
    //   return res.status(404).json({ msg: "User not found" });
    // }

    const { newUsername } = req.body;
    const { error } = changeUsernameSchema.validate({ username: newUsername });
    if (error) throw error;

    // user.username = newUsername;
    // await user.save();
    const user = await User.findOneAndUpdate(
      { username: username },
      { username: newUsername },
      { new: true }
    );

    if (!user) {
      return res.status(404).json({ msg: "User not found" });
    }
    const accessToken = jwt.sign(
      {
        name: user.username,
      },
      process.env.ACCESS_TOKEN_SECRET,
      {
        expiresIn: 3600000 * 24 * 7,
      }
    );

    const pipeline = redis.pipeline();
    pipeline.del(`user:${username}`);
    pipeline.hset(`user:${newUsername}`, {
      email: user.email,
      username: user.username,
      socketId: user.socketId,
    });
    pipeline.expire(`user:${newUsername}`, 3600 * 24 * 7);
    await pipeline.exec();

    return res
      .status(200)
      .cookie("accessToken", accessToken, {
        httpOnly: true,
        sameSite: "none",
        secure: true,
        maxAge: 3600000 * 24 * 7,
      })
      .json({ msg: "Username changed successfully" });
  } catch (error) {
    console.error(`💥💥 Error at /user[PATCH] `, error);
    if (Joi.isError(error)) {
      return res.status(403).json({ msg: error.details[0].message });
    }
    res.status(501).json({ msg: "Internal server error" });
  }
};
