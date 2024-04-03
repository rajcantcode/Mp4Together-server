import bcrypt from "bcrypt";
import { User } from "../model/User.js";
import jwt from "jsonwebtoken";
import { removeUserFromRoom } from "../helpers.js";
import redis from "../lib/databases/redis.js";
import {
  createUserSchema,
  loginUserEmailSchema,
  loginUserUsernameSchema,
} from "../lib/validators/UserSchema.js";
import Joi from "joi";

export const createUser = async (req, res) => {
  try {
    const { email, password, username } = req.body;
    const { error } = createUserSchema.validate({ email, password, username });
    if (error) {
      throw error;
    }
    const hashedPass = await bcrypt.hash(password, 10);
    const newUser = new User({
      email,
      password: hashedPass,
      username,
    });
    await newUser.save();
    res.status(201).json({ msg: "User registered successfully" });
  } catch (error) {
    console.error(`💥💥 Error at /register[post] `, { error });
    if (error.code === 11000) {
      if (error.keyPattern.email) {
        res.status(409).json({ message: "Email is already registered" });
      } else {
        res.status(409).json({ message: "Username is already taken" });
      }
    } else if (Joi.isError(error)) {
      res.status(403).json({ message: error.details[0].message });
    } else {
      res.status(501).json({ message: "Internal server error" });
    }
  }
};

export const loginUser = async (req, res) => {
  try {
    const { emailOrUsername, password } = req.body;
    let user;
    if (emailOrUsername.includes("@")) {
      const { error } = loginUserEmailSchema.validate({
        email: emailOrUsername,
        password,
      });
      if (error) throw error;
      user = await User.findOne({ email: emailOrUsername }).select("+password");
    } else {
      const { error } = loginUserUsernameSchema.validate({
        username: emailOrUsername,
        password,
      });
      if (error) throw error;
      user = await User.findOne({ username: emailOrUsername }).select(
        "+password"
      );
    }

    if (!user) {
      if (emailOrUsername.includes("@")) {
        return res
          .status(401)
          .json({ message: "No user with such email exists" });
      } else {
        return res
          .status(401)
          .json({ message: "No user with such username exists" });
      }
    }
    const hashedPassword = user.password;
    const match = await bcrypt.compare(password, hashedPassword);

    // Incorrect password
    if (!match) {
      return res.status(401).json({ message: "Incorrect password" });
    }

    // Valid login credentials
    // Generate a token for the user
    const accessToken = jwt.sign(
      { name: user.username },
      process.env.ACCESS_TOKEN_SECRET,
      { expiresIn: 3600000 * 24 * 7 }
    );

    // Cache user in redis
    await redis.hset(`user:${user.username}`, {
      email: user.email,
      username: user.username,
    });
    await redis.expire(`user:${user.username}`, 3600 * 24 * 7);

    res
      .status(200)
      .cookie("accessToken", accessToken, {
        httpOnly: true,
        // domain: "localhost",
        // path: "/",
        sameSite: "none",
        secure: true,
        maxAge: 3600000 * 24 * 7,
      })
      .json({ email: user.email, username: user.username });
  } catch (error) {
    console.error(`💥💥 Error at /login[post] `, error);
    if (Joi.isError(error)) {
      return res.status(403).json({ message: error.details[0].message });
    }
    res.status(501).json({ message: "Internal server error" });
  }
};

// This function is similar to "loginUser", the only difference is that we are not checking the password, since it is token based authentication, and also we are not sending a jwt token in response, cause it is token based authentication.
export const returnUser = async (req, res) => {
  try {
    // Get username from req, which is passed by "authenticateToken" middleware
    const username = req.user.name;
    // Verify if such a user exists
    const user =
      (await redis.hgetall(`user:${username}`)) ||
      (await User.findOne({ username }));
    if (!user) {
      res.status(404).json({ msg: "User not found" });
    } else {
      res.status(200).json({ email: user.email, username: user.username });
    }
  } catch (error) {
    console.error(`💥💥 Error at /auth[GET] `, error);
    res.status(501).json({ msg: "Internal server error" });
  }
};

export const logoutUser = async (req, res) => {
  try {
    // Get username from req, which is passed by "authenticateToken" middleware
    const username = req.user.name;
    // Verify if such a user exists
    const user = await User.findOne({ username });
    if (!user) {
      res.status(404).json({ msg: "User not found" });
    } else {
      if (user.roomId !== "") {
        await removeUserFromRoom(user.roomId, user.username);
        user.roomId = "";
        user.room = null;
      }

      // Delete user from redis
      await redis.del(`user:${username}`);
      // Clear the accessToken cookie
      res.setHeader(
        "Set-Cookie",
        cookie.serialize("accessToken", "", {
          expires: new Date(0), // Set the expiration date to a past date
          path: "/", // Make sure to set the same path as the original cookie
          httpOnly: true, // Ensure httpOnly flag is set
        })
      );
    }
  } catch (error) {
    console.log("Error at /logout[POST]", error);
    res.status(501).json({ msg: "Internal server error" });
  }
};
