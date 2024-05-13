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
    roomId: String,
    room: { type: mongoose.Schema.Types.ObjectId, ref: "room" },
    socketId: String,
  },
  { timestamps: true }
);

userSchema.index({ guest: 1 });

export const User = mongoose.model("user", userSchema);
