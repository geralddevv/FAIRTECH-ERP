// Moves all COLOR label bindings from labelsBinding → colorlabelsbinding
// and updates each user's colorLabel array to reference the new collection.
// Safe to re-run — duplicate-key errors are skipped.
import mongoose from "mongoose";
import * as dotenv from "dotenv";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
dotenv.config({ path: join(dirname(fileURLToPath(import.meta.url)), "../.env") });

import connectDB from "../config/db.js";
await connectDB();

const src  = mongoose.connection.collection("labelsBinding");
const dest = mongoose.connection.collection("colorlabelsbinding");
const users = mongoose.connection.collection("usernames");

const colorDocs = await src.find({ jobType: "COLOR" }).toArray();
console.log(`Found ${colorDocs.length} COLOR binding(s) in labelsBinding.\n`);

let inserted = 0, skipped = 0, failed = 0;
const migratedIds = [];

for (const doc of colorDocs) {
  try {
    await dest.insertOne(doc);
    migratedIds.push(doc._id);
    inserted++;
    console.log(`  Migrated binding: ${doc.productId} (${doc._id})`);
  } catch (err) {
    if (err.code === 11000) {
      migratedIds.push(doc._id);
      skipped++;
      console.log(`  Skipped (already exists): ${doc.productId}`);
    } else {
      failed++;
      console.error(`  FAILED: ${doc.productId} — ${err.message}`);
    }
  }
}

console.log(`\nBinding migration done. Inserted: ${inserted} | Skipped: ${skipped} | Failed: ${failed}`);

if (failed > 0) {
  console.error("\nThere were failures — NOT updating users or deleting source docs. Fix and re-run.");
  await mongoose.disconnect();
  process.exit(1);
}

// Move refs from user.label → user.colorLabel for each migrated binding
if (migratedIds.length > 0) {
  const affectedUsers = await users.find({ label: { $in: migratedIds } }).toArray();
  console.log(`\nUpdating ${affectedUsers.length} user(s) with colorLabel refs...`);

  for (const user of affectedUsers) {
    const toMove = (user.label || []).filter(id => migratedIds.some(m => String(m) === String(id)));
    const remainingLabel = (user.label || []).filter(id => !migratedIds.some(m => String(m) === String(id)));
    const existingColorLabel = user.colorLabel || [];
    const newColorLabel = [...new Set([...existingColorLabel.map(String), ...toMove.map(String)])].map(
      id => new mongoose.Types.ObjectId(id)
    );

    await users.updateOne(
      { _id: user._id },
      { $set: { label: remainingLabel, colorLabel: newColorLabel } }
    );
    console.log(`  User ${user.userName}: moved ${toMove.length} binding(s) to colorLabel`);
  }

  // Delete migrated docs from source
  const del = await src.deleteMany({ _id: { $in: migratedIds } });
  console.log(`\nDeleted ${del.deletedCount} COLOR binding(s) from labelsBinding.`);
}

await mongoose.disconnect();
