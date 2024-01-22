import mongoose from "mongoose";
const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
    },
    password: {
      type: String,
      required: true,
    },
    username: {
      type: String,
      required: true,
      unique: true,
    },
    roomId: String,
    room: { type: mongoose.Schema.Types.ObjectId, ref: "room" },
    socketId: String,
  },
  { timestamps: true }
);

export const User = mongoose.model("user", userSchema);
