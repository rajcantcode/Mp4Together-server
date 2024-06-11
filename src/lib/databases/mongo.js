import mongoose from "mongoose";
const connectToMongoose = async () => {
  try {
    if (!process.env.DB_URL) {
      // if (process.env.NODE_ENV === "development") {
      //   console.log("connecting to local mongo server...");
      //   return await mongoose.connect("mongodb://localhost:27017/Watch2Gether");
      // }
      throw new Error("Database link not set");
    }
    await mongoose.connect(process.env.DB_URL);
  } catch (error) {
    throw error;
  }
};

export default connectToMongoose;
