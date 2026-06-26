/**
 * Migration: remove paperType, paperCode, labelUps, labelCore from the
 * labels (LabelMaster) collection. These fields are now stored at the
 * binding level (labelsBinding) instead.
 * Run once: node scripts/remove-master-spec-fields.js
 */

import mongoose from "mongoose";
import * as dotenv from "dotenv";
dotenv.config();

await mongoose.connect(process.env.MONGO_URI);

const collection = mongoose.connection.collection("labels");

const result = await collection.updateMany(
  {},
  { $unset: { paperType: "", paperCode: "", labelUps: "", labelCore: "" } }
);

console.log(`Matched: ${result.matchedCount} — Updated: ${result.modifiedCount}`);

await mongoose.disconnect();
