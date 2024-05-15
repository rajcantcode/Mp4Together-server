import mongoose from "mongoose";
const userSchema = new mongoose.Schema(
  {
    email: {
      type: String,
      required: function () {
        return !this.guest;
      },
      unique: true,
    },
    password: {
      type: String,
      required: function () {
        return !this.guest;
      },
      select: false,
    },
    username: {
      type: String,
      required: true,
      unique: true,
    },
    verified: {
      type: Boolean,
      default: false,
    },
    guest: {
      type: Boolean,
      default: false,
    },
    roomIds: [String],
    rooms: [{ type: mongoose.Schema.Types.ObjectId, ref: "room" }],
    socketIds: [
      {
        _id: false,
        room: String,
        socketId: String,
      },
    ],
  },
  { timestamps: true }
);

userSchema.index({ guest: 1 });

export const User = mongoose.model("user", userSchema);
