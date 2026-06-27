import crypto from "crypto";
import mongoose from "mongoose";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

import connectDB from "../config/db.js";
await connectDB();

const col = mongoose.connection.collection("labels");

// Step 1: unset the five removed fields from every master document.
const unsetResult = await col.updateMany(
  {},
  { $unset: { frontColor: "", backColor: "", varnish: "", foilNo: "", firstOut: "" } },
);
console.log(`Step 1 — $unset: ${unsetResult.modifiedCount} document(s) updated.\n`);

// Step 2: rebuild signatures with the new (slimmer) formula.
function buildSignature(doc) {
  return [
    String(doc.jobType      ?? "").trim().toUpperCase(),
    String(doc.jobName      ?? "").trim().toUpperCase(),
    String(doc.instructions ?? "").trim().toUpperCase(),
    String(doc.labelFamily  ?? "").trim().toUpperCase(),
    String(doc.labelWidth   ?? "").trim(),
    String(doc.labelHeight  ?? "").trim(),
    String(doc.labelGap     ?? "").trim(),
    String(doc.perRollQty   ?? "").trim(),
  ].join("||");
}

function hashSignature(raw) {
  return `sha256:${crypto.createHash("sha256").update(raw).digest("hex")}`;
}

const docs = await col.find({}).toArray();
console.log(`Step 2 — rebuilding signatures for ${docs.length} document(s).\n`);

let updated = 0;
let skipped = 0;
let conflicts = 0;
const seen = new Map();

for (const doc of docs) {
  const newSig = hashSignature(buildSignature(doc));

  if (seen.has(newSig)) {
    console.warn(`  CONFLICT: ${doc.labelProductId} collides with ${seen.get(newSig)} — skipping`);
    conflicts++;
    continue;
  }
  seen.set(newSig, doc.labelProductId);

  if (doc.labelSignature === newSig) {
    skipped++;
    continue;
  }

  await col.updateOne({ _id: doc._id }, { $set: { labelSignature: newSig } });
  console.log(`  Updated sig: ${doc.labelProductId}`);
  updated++;
}

console.log(`\nStep 2 done. Updated: ${updated} | Already correct: ${skipped} | Conflicts: ${conflicts}`);
await mongoose.disconnect();
