import crypto from "crypto";
import mongoose from "mongoose";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

import connectDB from "../../config/db.js";
await connectDB();

const col = mongoose.connection.collection("labels");

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
console.log(`Found ${docs.length} label master document(s).\n`);

// --- Step 1: normalize jobName ---
let jobNameUpdated = 0;
for (const doc of docs) {
  const expectedJobName = doc.jobType === "COLOR" ? "COLOR" : "PLAIN";
  const current = String(doc.jobName ?? "").trim().toUpperCase();
  if (current !== expectedJobName) {
    await col.updateOne({ _id: doc._id }, { $set: { jobName: expectedJobName } });
    console.log(`  [jobName] ${doc.labelProductId}: "${doc.jobName ?? ""}" → "${expectedJobName}"`);
    doc.jobName = expectedJobName; // update in-memory for signature step below
    jobNameUpdated++;
  }
}
console.log(`\nStep 1 done. jobName normalized on ${jobNameUpdated} document(s).\n`);

// --- Step 2: rebuild signatures from current (now normalized) data ---
let sigUpdated = 0;
let sigSkipped = 0;
let conflicts = 0;
const seen = new Map(); // newSig → labelProductId

for (const doc of docs) {
  const newSig = hashSignature(buildSignature(doc));

  if (seen.has(newSig)) {
    console.warn(`  [sig] CONFLICT: ${doc.labelProductId} collides with ${seen.get(newSig)} — skipping`);
    conflicts++;
    continue;
  }
  seen.set(newSig, doc.labelProductId);

  if (doc.labelSignature === newSig) {
    sigSkipped++;
    continue;
  }

  await col.updateOne({ _id: doc._id }, { $set: { labelSignature: newSig } });
  console.log(`  [sig]    ${doc.labelProductId}: signature updated`);
  sigUpdated++;
}

console.log(`\nStep 2 done. Signatures updated: ${sigUpdated} | Already correct: ${sigSkipped} | Conflicts: ${conflicts}`);
await mongoose.disconnect();
