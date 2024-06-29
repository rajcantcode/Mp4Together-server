import bcrypt from "bcrypt";
import { User } from "../model/User.js";
import jwt from "jsonwebtoken";
import { removeUserFromRoom } from "../services/helpers.js";
import redis from "../lib/databases/redis.js";
import {
  changeUsernameSchema,
  createUserSchema,
  loginUserEmailSchema,
  loginUserUsernameSchema,
  resendOtpSchema,
  verifyOtpSchema,
} from "../lib/validators/UserSchema.js";
import { nouns, adjectives } from "../lib/utils/constants.js";
import Joi from "joi";
import nodemailer from "nodemailer";

const environment = process.env.NODE_ENV || "development";

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
      verified: environment === "development" ? true : false,
    });
    await newUser.save();

    if (environment === "development") {
      return res.status(201).json({ email: newUser.email, verified: true });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await redis.set(`otp:${newUser.email}`, otp, "EX", 300);
    const messageId = await sendOtpToEmail(newUser.email, otp);

    return res.status(201).json({ email: newUser.email });
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

const sendOtpToEmail = async (email, otp) => {
  try {
    const transport = nodemailer.createTransport({
      host: "sandbox.smtp.mailtrap.io",
      port: 2525,
      auth: {
        user: process.env.TEMP_USER_MAIL,
        pass: process.env.TEMP_USER_PASS,
      },
    });

    const message = await transport.sendMail({
      from: process.env.MAILSENDER,
      to: email,
      subject: "Verification code for mp4together",
      text: `Your verification code is ${otp}`,
    });

    return message.messageId;
  } catch (error) {
    console.error(error);
    throw error;
  }
};

export const resendOtp = async (req, res) => {
  try {
    const { email } = req.body;
    const { error } = resendOtpSchema.validate({ email });
    if (error) throw error;
    const user = await User.findOne({ email });
    if (!user || user.verified) {
      return res
        .status(404)
        .json({ message: "User not found or already verified" });
    }
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await redis.set(`otp:${email}`, otp, "EX", 300);
    const messageId = await sendOtpToEmail(email, otp);
    return res.status(200).json({ message: "OTP sent successfully" });
  } catch (error) {
    if (Joi.isError(error)) {
      return res.status(403).json({ message: error.details[0].message });
    } else {
      console.error(`💥💥 Error at /resendOtp[post] `, error);
      res.status(501).json({ message: "Internal server error" });
    }
  }
};

export const verifyOtp = async (req, res) => {
  try {
    const { email, otp } = req.body;
    const { error } = verifyOtpSchema.validate({ email, otp });
    if (error) throw error;

    const savedOtp = await redis.get(`otp:${email}`);
    if (!savedOtp) {
      return res.status(401).json({ message: "OTP expired" });
    }
    if (savedOtp !== otp) {
      return res.status(401).json({ message: "Invalid OTP" });
    }
    const user = await User.findOneAndUpdate(
      { email },
      { verified: true },
      { new: true }
    );
    await redis.del(`otp:${email}`);

    if (req.body.sendUserDetails) {
      const accessToken = jwt.sign(
        { name: user.username },
        process.env.ACCESS_TOKEN_SECRET,
        { expiresIn: 3600000 * 24 * 7 }
      );

      // Cache user in redis
      const pipeline = redis.pipeline();
      pipeline.hset(`user:${user.username}`, {
        email: user.email,
        username: user.username,
      });
      pipeline.expire(`user:${user.username}`, 3600 * 24 * 7);
      await pipeline.exec();

      return res
        .status(200)
        .cookie("accessToken", accessToken, {
          httpOnly: true,
          domain: process.env.COOKIE_DOMAIN || "localhost",
          path: "/",
          sameSite: "none",
          secure: true,
          maxAge: 3600000 * 24 * 7,
        })
        .json({ email: user.email, username: user.username });
    }
    return res.status(200).json({ message: "OTP verified successfully" });
  } catch (error) {
    if (Joi.isError(error)) {
      return res.status(403).json({ message: error.details[0].message });
    } else {
      console.error(`💥💥 Error at /verifyOtp[post] `, error);
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

    // Check if user is verified
    if (!user.verified) {
      const otp = Math.floor(100000 + Math.random() * 900000).toString();
      await redis.set(`otp:${user.email}`, otp, "EX", 300);
      const messageId = await sendOtpToEmail(user.email, otp);
      return res.status(401).json({ email: user.email });
    }
    // Generate a token for the user
    const accessToken = jwt.sign(
      { name: user.username },
      process.env.ACCESS_TOKEN_SECRET,
      { expiresIn: 3600000 * 24 * 7 }
    );

    // Cache user in redis
    const pipeline = redis.pipeline();
    pipeline.hset(`user:${user.username}`, {
      email: user.email,
      username: user.username,
    });
    pipeline.expire(`user:${user.username}`, 3600 * 24 * 7);
    await pipeline.exec();

    res
      .status(200)
      .cookie("accessToken", accessToken, {
        httpOnly: true,
        domain: process.env.COOKIE_DOMAIN || "localhost",
        path: "/",
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

export const guestLogin = async (req, res) => {
  try {
    const username = `${
      adjectives[Math.floor(Math.random() * adjectives.length)]
    }${nouns[Math.floor(Math.random() * nouns.length)]}`;
    const email = `${username}@notamail.com`;

    const newUser = new User({
      email,
      username,
      guest: true,
    });
    await newUser.save();
    const accessToken = jwt.sign(
      { name: newUser.username, guest: true },
      process.env.ACCESS_TOKEN_SECRET,
      { expiresIn: "1h" }
    );

    // Cache user in redis
    const pipeline = redis.pipeline();
    pipeline.hset(`guest:${newUser.username}`, {
      email: newUser.email,
      username: newUser.username,
      guest: true,
    });
    pipeline.expire(`guest:${newUser.username}`, 3600);
    await pipeline.exec();

    res
      .status(200)
      .cookie("accessToken", accessToken, {
        httpOnly: true,
        domain: process.env.COOKIE_DOMAIN || "localhost",
        path: "/",
        sameSite: "none",
        secure: true,
        maxAge: 4800000,
      })
      .json({ email: newUser.email, username: newUser.username });
  } catch (error) {
    console.error(`💥💥 Error at /guestLogin[post] `, error);
    if (error.code === 11000) {
      return guestLogin(req, res);
    } else {
      res.status(501).json({ message: "Internal server error" });
    }
  }
};

// delete guest accounts that are older than 1 hour
// Check if they are in any rooms, if they are, then emit "trialExpire" event to the user which will initiate exit room process for the user
export const deleteOldDocuments = async (io) => {
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const guestUsers = await User.find({
    guest: true,
    createdAt: { $lt: oneHourAgo },
  });
  guestUsers.forEach(async (user) => {
    if (user.roomIds.length > 0) {
      user.roomIds.forEach((roomId) => {
        const socketId = user.socketIds.find((s) => s.room === roomId).socketId;
        io.to(socketId).emit("trialExpire");
      });
    } else {
      await User.deleteOne({ username: user.username });
      await redis.del(`guest:${user.username}`);
    }
  });
};

export const logoutUser = async (req, res) => {
  try {
    res.setHeader(
      "Set-Cookie",
      `accessToken=; Expires=${new Date(0).toUTCString()}; Path=/; Domain=${
        process.env.COOKIE_DOMAIN || "localhost"
      }; Secure; SameSite=None HttpOnly`
    );
    res.status(200).json({ msg: "Logged out successfully" });
    // Get username from req, which is passed by "authenticateToken" middleware
    const username = req.user.name;
    const guest = req.user.guest;

    // Check if user is a guest and delete if true
    const user = await User.findOneAndDelete({ username, guest: true });
    await redis.del(`${guest ? `guest:${username}` : `user:${username}`}`);
  } catch (error) {
    console.error("Error at /logout[POST]", error);
  }
};
