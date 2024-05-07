import express from "express";

import { changeUsername, returnUser } from "../controller/User.js";
const router = express.Router();

router.get("/", returnUser).patch("/", changeUsername);

export default router;
