import { Redis } from "ioredis";
import dotenv from "dotenv";
dotenv.config();
export const connect = () => {
  try {
    if (!process.env.REDIS_URL) {
      throw new Error("redis url is not set");
    }
    return new Redis(process.env.REDIS_URL);
  } catch (error) {
    console.error(error);
  }
};

const redis = connect();

export default redis;
