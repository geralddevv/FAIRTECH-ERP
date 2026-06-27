// Moves all COLOR label masters out of the `labels` collection into the new
// `colorlabels` collection.  Run ONCE before deploying the updated routes.
// Safe to re-run — duplicate-key errors are skipped.
import mongoose from "mongoose";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

import connectDB from "../config/db.js";
await connectDB();

const src  = mongoose.connection.collection("labels");
const dest = mongoose.connection.collection("colorlabels");

const colorDocs = await src.find({ jobType: "COLOR" }).toArray();
console.log(`Found ${colorDocs.length} COLOR label master(s) in labels.\n`);

let inserted = 0;
let skipped  = 0;
let failed   = 0;
const migratedIds = [];

for (const doc of colorDocs) {
  try {
    await dest.insertOne(doc);
    migratedIds.push(doc._id);
    inserted++;
    console.log(`  Migrated: ${doc.labelProductId} (${doc._id})`);
  } catch (err) {
    if (err.code === 11000) {
      migratedIds.push(doc._id);
      skipped++;
      console.log(`  Skipped (already exists): ${doc.labelProductId}`);
    } else {
      failed++;
      console.error(`  FAILED: ${doc.labelProductId} — ${err.message}`);
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
  console.log(`\nDeleted ${del.deletedCount} COLOR document(s) from labels collection.`);
}

await mongoose.disconnect();
