import mongoose from "mongoose";
const roomSchema = new mongoose.Schema(
  {
    mainRoomId: {
      type: String,
      required: true,
      unique: true,
    },
    socketRoomId: {
      type: String,
      required: true,
      unique: true,
    },
    videoUrl: {
      type: String,
    },
    members: [
      { type: mongoose.Schema.Types.ObjectId, ref: "user", unique: true },
    ],
    admins: [
      { type: mongoose.Schema.Types.ObjectId, ref: "user", unique: true },
    ],
    membersMicState: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);
export const Room = mongoose.model("room", roomSchema);
