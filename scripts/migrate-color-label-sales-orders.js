// Moves all COLOR label sales orders from labelsalesorders → colorlabelsalesorders.
// Safe to re-run — duplicate-key errors are skipped.
import mongoose from "mongoose";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

import connectDB from "../config/db.js";
await connectDB();

const src  = mongoose.connection.collection("labelsalesorders");
const dest = mongoose.connection.collection("colorlabelsalesorders");

// COLOR label bindings are now in colorlabelsbinding; get those IDs to match orders
const colorBindingIds = (await mongoose.connection.collection("colorlabelsbinding").find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id);
console.log(`Found ${colorBindingIds.length} COLOR binding(s) in colorlabelsbinding.`);

const colorOrders = await src.find({ labelId: { $in: colorBindingIds } }).toArray();
console.log(`Found ${colorOrders.length} COLOR label sales order(s) in labelsalesorders.\n`);

let inserted = 0, skipped = 0, failed = 0;
const migratedIds = [];

for (const doc of colorOrders) {
  const newDoc = {
    ...doc,
    colorLabelId: doc.labelId,
    onModel: "ColorLabel",
  };

  try {
    await dest.insertOne(newDoc);
    migratedIds.push(doc._id);
    inserted++;
    console.log(`  Migrated order: ${doc._id}`);
  } catch (err) {
    if (err.code === 11000) {
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
  console.error("\nThere were failures — NOT deleting source docs. Fix and re-run.");
  await mongoose.disconnect();
  process.exit(1);
}

if (migratedIds.length > 0) {
  const del = await src.deleteMany({ _id: { $in: migratedIds } });
  console.log(`\nDeleted ${del.deletedCount} COLOR order(s) from labelsalesorders.`);
}

await mongoose.disconnect();
