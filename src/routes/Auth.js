import express from "express";
import {
  createUser,
  guestLogin,
  loginUser,
  logoutUser,
  resendOtp,
  verifyOtp,
} from "../controller/Auth.js";
import { returnUser } from "../controller/User.js";
import { authenticateToken } from "../services/helpers.js";
const router = express.Router();

router
  .get(
    "/",
    (req, res, next) => authenticateToken(req, res, next, true),
    returnUser
  )
  .post("/signup", createUser)
  .post("/verify", verifyOtp)
  .put("/resend", resendOtp)
  .post("/login", loginUser)
  .post("/guest", guestLogin)
  .post("/logout", authenticateToken, logoutUser);

export default router;
