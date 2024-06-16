import express from "express";
import {
  createRoom,
  joinRoom,
  exitRoom,
  userTrialExpired,
  saveUrl,
  getVideoDetails,
} from "../controller/Room.js";

const router = express.Router();

router
  .post("/create", createRoom)
  .post("/trial/:id", userTrialExpired)
  .post("/join/:id", joinRoom)
  .post("/exit/:id", exitRoom)
  .get("/youtube", getVideoDetails)
  .post("/:id", saveUrl);

export default router;
