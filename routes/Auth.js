import express from "express";
import {
  createUser,
  loginUser,
  logoutUser,
  resendOtp,
  verifyOtp,
} from "../controller/Auth.js";
import { returnUser } from "../controller/User.js";
import { authenticateToken } from "../helpers.js";
const router = express.Router();

router
  .get(
    "/",
    (req, res, next) => authenticateToken(req, res, next, true),
    returnUser
  )
  .post("/signup", createUser)
  .put("/verify", verifyOtp)
  .put("/resend", resendOtp)
  .post("/login", loginUser)
  .post("/logout", authenticateToken, logoutUser);

export default router;
