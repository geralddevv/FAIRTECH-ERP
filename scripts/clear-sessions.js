import mongoose from "mongoose";
import MongoSessionStore from "../utils/mongoSessionStore.js";
import { configDotenv } from "dotenv";

configDotenv();

async function clearAllSessions() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✓ Connected to MongoDB");

    const sessionStore = new MongoSessionStore({
      ttlMs: 30 * 60 * 1000,
    });

    await new Promise((resolve, reject) => {
      sessionStore.clear((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    console.log("✓ All sessions cleared successfully");

    await mongoose.connection.close();
    console.log("✓ Database connection closed");
  } catch (error) {
    console.error("Failed to clear sessions:", error);
    process.exit(1);
  }
}

clearAllSessions();
