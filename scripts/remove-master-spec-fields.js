/**
 * Migration: remove paperType, paperCode, labelUps, labelCore from the
 * labels (LabelMaster) collection. These fields are now stored at the
 * binding level (labelsBinding) instead.
 * Run once: node scripts/remove-master-spec-fields.js
 */

import mongoose from "mongoose";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

import connectDB from "../config/db.js";
await connectDB();

const collection = mongoose.connection.collection("labels");

const result = await collection.updateMany(
  {},
  { $unset: { paperType: "", paperCode: "", labelUps: "", labelCore: "" } }
);

console.log(`Matched: ${result.matchedCount} — Updated: ${result.modifiedCount}`);

await mongoose.disconnect();
