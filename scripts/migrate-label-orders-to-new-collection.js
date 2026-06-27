// Moves all label sales orders out of tapesalesorders into the new labelsalesorders collection.
// Run ONCE before deploying the updated routes.  Safe to re-run — duplicate-key errors are skipped.
import mongoose from "mongoose";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

import connectDB from "../config/db.js";
await connectDB();

const src  = mongoose.connection.collection("tapesalesorders");
const dest = mongoose.connection.collection("labelsalesorders");

const labelOrders = await src.find({ onModel: "Label" }).toArray();
console.log(`Found ${labelOrders.length} label order(s) in tapesalesorders.\n`);

let inserted = 0;
let skipped  = 0;
let failed   = 0;
const migratedIds = [];

for (const doc of labelOrders) {
  const newDoc = {
    _id:                doc._id,
    labelId:            doc.tapeId,          // canonical reference
    tapeId:             doc.tapeId,          // compat alias
    onModel:            "Label",
    userId:             doc.userId,
    quantity:           doc.quantity,
    dispatchedQuantity: doc.dispatchedQuantity ?? 0,
    poDate:             doc.poDate,
    poNumber:           doc.poNumber,
    orderRate:          doc.orderRate ?? 0,
    estimatedDate:      doc.estimatedDate,
    status:             doc.status ?? "PENDING",
    remarks:            doc.remarks,
    createdBy:          doc.createdBy ?? "SYSTEM",
    submissionToken:    doc.submissionToken,
    orderSignature:     doc.orderSignature,
    createdAt:          doc.createdAt,
    updatedAt:          doc.updatedAt,
  };

  try {
    await dest.insertOne(newDoc);
    migratedIds.push(doc._id);
    inserted++;
    console.log(`  Migrated: ${doc._id}`);
  } catch (err) {
    if (err.code === 11000) {
      // Already migrated (duplicate _id or unique index)
      migratedIds.push(doc._id);
      skipped++;
      console.log(`  Skipped (already exists): ${doc._id}`);
    } else {
      failed++;
      console.error(`  FAILED: ${doc._id} — ${err.message}`);
    }
  }
}

console.log(`\nMigration done. Inserted: ${inserted} | Skipped: ${skipped} | Failed: ${failed}`);

if (failed > 0) {
  console.error("\nThere were failures — NOT deleting source documents. Fix errors and re-run.");
  await mongoose.disconnect();
  process.exit(1);
}

if (migratedIds.length > 0) {
  const del = await src.deleteMany({ _id: { $in: migratedIds } });
  console.log(`\nDeleted ${del.deletedCount} document(s) from tapesalesorders.`);
}

await mongoose.disconnect();
