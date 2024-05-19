import express from "express";
import {
  createRoom,
  joinRoom,
  exitRoom,
  saveUrl,
  getVideoDetails,
} from "../controller/Room.js";

const router = express.Router();

router
  .post("/create", createRoom)
  .post("/join/:id", joinRoom)
  .post("/exit/:id", exitRoom)
  .get("/youtube", getVideoDetails)
  .post("/:id", saveUrl);

export default router;
