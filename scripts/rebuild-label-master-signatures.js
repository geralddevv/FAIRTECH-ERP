import crypto from "crypto";
import mongoose from "mongoose";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

import connectDB from "../config/db.js";
await connectDB();

const col = mongoose.connection.collection("labels");

function buildSignature(doc) {
  return [
    String(doc.jobType      ?? "").trim().toUpperCase(),
    String(doc.jobName      ?? "").trim().toUpperCase(),
    String(doc.frontColor   ?? "").trim(),
    String(doc.backColor    ?? "").trim(),
    String(doc.instructions ?? "").trim().toUpperCase(),
    String(doc.varnish      ?? "").trim().toUpperCase(),
    String(doc.foilNo       ?? "").trim(),
    String(doc.labelFamily  ?? "").trim().toUpperCase(),
    String(doc.labelWidth   ?? "").trim(),
    String(doc.labelHeight  ?? "").trim(),
    String(doc.labelGap     ?? "").trim(),
    String(doc.perRollQty   ?? "").trim(),
    String(doc.firstOut     ?? "").trim(),
  ].join("||");
}

function hashSignature(raw) {
  return `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`;
}

const docs = await col.find({}).toArray();
console.log(`Found ${docs.length} label master document(s). Rebuilding signatures...\n`);

let updated = 0;
let skipped = 0;
let conflicts = 0;
const seen = new Map(); // newSig -> labelProductId (to detect collisions)

for (const doc of docs) {
  const newSig = hashSignature(buildSignature(doc));

  // Check if another doc already claimed this signature
  if (seen.has(newSig)) {
    console.warn(`  CONFLICT: ${doc.labelProductId} has the same signature as ${seen.get(newSig)} — skipping`);
    conflicts++;
    continue;
  }
  seen.set(newSig, doc.labelProductId);

  if (doc.labelSignature === newSig) {
    skipped++;
    continue;
  }

  await col.updateOne({ _id: doc._id }, { $set: { labelSignature: newSig } });
  console.log(`  Updated: ${doc.labelProductId}`);
  updated++;
}

console.log(`\nDone. Updated: ${updated} | Already correct: ${skipped} | Conflicts skipped: ${conflicts}`);
await mongoose.disconnect();
