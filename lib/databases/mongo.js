import mongoose from "mongoose";

const connectToMongoose = async () => {
  try {
    if (!process.env.DBLINK) {
      throw new Error("Database link not set");
    }
    await mongoose.connect(process.env.DBLINK);
  } catch (error) {
    throw error;
  }
};

export default connectToMongoose;
