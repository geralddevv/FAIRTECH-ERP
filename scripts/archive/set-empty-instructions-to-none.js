import mongoose from "mongoose";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

import connectDB from "../../config/db.js";
await connectDB();

const filter = { $or: [{ instructions: { $exists: false } }, { instructions: null }, { instructions: "" }] };
const update = { $set: { instructions: "NONE" } };

const masterResult = await mongoose.connection.collection("labels").updateMany(filter, update);
console.log(`labels (master):  Matched: ${masterResult.matchedCount} — Updated: ${masterResult.modifiedCount}`);

const bindingResult = await mongoose.connection.collection("labelsBinding").updateMany(filter, update);
console.log(`labelsBinding:    Matched: ${bindingResult.matchedCount} — Updated: ${bindingResult.modifiedCount}`);

await mongoose.disconnect();
