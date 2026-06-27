import mongoose from "mongoose";
import TapeBinding from "../../models/inventory/tapeBinding.js";
import "../../models/inventory/tape.js";
import dotenv from "dotenv";

dotenv.config();

async function sync() {
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

    const bindings = await TapeBinding.find({
      $or: [{ itemClientItemType: { $exists: false } }, { itemClientItemType: "" }],
    }).populate("tapeId", "tapePaperType");

    let updated = 0;
    for (const binding of bindings) {
      const paperType = binding.tapeId?.tapePaperType;
      if (!paperType) continue;
      binding.itemClientItemType = paperType;
      await binding.save();
      updated++;
    }

    console.log(`Synced ${updated} bindings to their tape master's paper type.`);
    process.exit(0);
  } catch (err) {
    console.error("Sync failed:", err);
    process.exit(1);
  }
}

sync();
