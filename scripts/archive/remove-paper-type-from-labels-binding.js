import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Label from "../models/inventory/labels.js";
import dotenv from "dotenv";

// Load .env from the FAIRTECH root regardless of the current working directory
// (the script may be run from scripts/ or from the project root).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// One-off cleanup: drop the deprecated `paperType` field from every
// document in the `labelsBinding` collection (the Label model).
async function run() {
  try {
    let uri = process.env.MONGO_URI || "mongodb://localhost:27017/fairdesk";
    const user = process.env.MONGO_USER;
    const pass = process.env.MONGO_PASS;
    if (user && pass && uri.startsWith("mongodb://") && !uri.includes("@")) {
      uri = uri.replace("mongodb://", `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`);
      if (!uri.includes("authSource")) uri += (uri.includes("?") ? "&" : "?") + "authSource=admin";
    }
    await mongoose.connect(uri);
    console.log("Database connected.");

    const res = await Label.collection.updateMany(
      { paperType: { $exists: true } },
      { $unset: { paperType: "" } },
    );

    console.log(`Removed paperType from ${res.modifiedCount} of ${res.matchedCount} matched binding(s).`);
    process.exit(0);
  } catch (err) {
    console.error("Cleanup failed:", err);
    process.exit(1);
  }
}

run();
