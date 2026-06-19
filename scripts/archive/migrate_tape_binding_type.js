import mongoose from "mongoose";
import TapeBinding from "../../models/inventory/tapeBinding.js";
import dotenv from "dotenv";

dotenv.config();

async function migrate() {
  try {
    console.log("Connecting to database...");
    await mongoose.connect(process.env.MONGO_URI || "mongodb://localhost:27017/fairdesk");
    console.log("Database connected.");

    console.log("Updating existing TapeBinding records...");
    const result = await TapeBinding.updateMany(
      { itemClientItemType: { $exists: false } },
      { $set: { itemClientItemType: "Standard" } },
    );

    console.log(`Successfully updated ${result.modifiedCount} records.`);
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  }
}

migrate();
