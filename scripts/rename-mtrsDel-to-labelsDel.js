/**
 * Migration: rename `mtrsDel` → `labelsDel` in the labelsBinding collection.
 * Run once: node scripts/rename-mtrsDel-to-labelsDel.js
 */

import mongoose from "mongoose";
import * as dotenv from "dotenv";
dotenv.config();

await mongoose.connect(process.env.MONGO_URI);

const collection = mongoose.connection.collection("labelsBinding");

const result = await collection.updateMany(
  { mtrsDel: { $exists: true } },
  { $rename: { mtrsDel: "labelsDel" } }
);

console.log(`Matched: ${result.matchedCount} — Updated: ${result.modifiedCount}`);

await mongoose.disconnect();
