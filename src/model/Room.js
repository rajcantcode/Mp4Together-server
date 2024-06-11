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
    playbackSpeed: {
      type: Number,
      default: 1,
    },
    members: [String],
    admins: [String],
    membersMicState: {
      type: mongoose.Schema.Types.Mixed,
      default: {},
    },
  },
  { timestamps: true }
);
export const Room = mongoose.model("room", roomSchema);
