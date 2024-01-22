import express from "express";
import { createRoom, joinRoom, exitRoom, saveUrl } from "../controller/Room.js";

const router = express.Router();

router
  .post("/create", createRoom)
  .post("/join/:id", joinRoom)
  .post("/exit/:id", exitRoom)
  .post("/:id", saveUrl);

export default router;
