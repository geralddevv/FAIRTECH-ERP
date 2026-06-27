import mongoose from "mongoose";
import TapeBinding from "../../models/inventory/tapeBinding.js";
import dotenv from "dotenv";

dotenv.config();

async function debug() {
  try {
    let uri = process.env.MONGO_URI || "mongodb://localhost:27017/fairtech";
    const user = process.env.MONGO_USER;
    const pass = process.env.MONGO_PASS;
    if (user && pass && uri.startsWith("mongodb://") && !uri.includes("@")) {
      uri = uri.replace("mongodb://", `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`);
      if (!uri.includes("authSource")) uri += (uri.includes("?") ? "&" : "?") + "authSource=admin";
    }
    await mongoose.connect(uri);
    console.log("Database connected.");

    const total = await TapeBinding.countDocuments();
    console.log(`Total TapeBinding documents: ${total}`);

    const sample = await TapeBinding.find().limit(10).lean();
    sample.forEach((b, i) => {
      console.log(`[${i + 1}] _id: ${b._id} | itemClientItemType: ${JSON.stringify(b.itemClientItemType)} | type: ${typeof b.itemClientItemType}`);
    });

    process.exit(0);
  } catch (err) {
    console.error("Debug failed:", err);
    process.exit(1);
  }
}

debug();
