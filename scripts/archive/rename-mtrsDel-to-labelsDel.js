/**
 * Migration: rename `mtrsDel` → `labelsDel` in the labelsBinding collection.
 * For documents that have `mtrsDel`, rename it to `labelsDel`.
 * For documents that don't have `mtrsDel`, copy `mtrs` into `labelsDel` as the default.
 * Run once: node scripts/rename-mtrsDel-to-labelsDel.js
 */

import mongoose from "mongoose";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

import connectDB from "../../config/db.js";
await connectDB();

const collection = mongoose.connection.collection("labelsBinding");

const rename = await collection.updateMany(
  { mtrsDel: { $exists: true } },
  { $rename: { mtrsDel: "labelsDel" } }
);
console.log(`Renamed mtrsDel → labelsDel: ${rename.modifiedCount}`);

const fallback = await collection.updateMany(
  { mtrsDel: { $exists: false }, labelsDel: { $exists: false } },
  [{ $set: { labelsDel: "$mtrs" } }]
);
console.log(`Fallback (copied mtrs → labelsDel): ${fallback.modifiedCount}`);

await mongoose.disconnect();
