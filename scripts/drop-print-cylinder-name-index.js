import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";

// ---------------------------------------------------------------------------
// Print Cylinder Master dropped its `printCylinderName` field (see
// models/utilities/printCylinder_model.js) -- it no longer carries a name at
// all. Mongoose never drops an index it no longer declares, so the old
// `unique: true` index on that field is still sitting on the collection.
// Left alone, every document from here on posts `printCylinderName: null`
// (the field is simply absent), and a non-sparse unique index only tolerates
// ONE document with that null value -- so the *second* print cylinder anyone
// creates after this change fails with a duplicate-key error.
//
// This is a pure structural fix -- it drops an index, never touches a
// document -- so it runs directly, no --apply flag. Safe to run more than
// once: dropping a missing index is a no-op, not an error.
// ---------------------------------------------------------------------------

const INDEX_NAME = "printCylinderName_1";

await connectDB();

const collection = mongoose.connection.db.collection("printcylinders");
const existing = await collection.indexes();
const found = existing.find((idx) => idx.name === INDEX_NAME);

console.log("");
console.log("=".repeat(78));
console.log("  DROP STALE printCylinderName INDEX");
console.log("=".repeat(78));
console.log("");

if (!found) {
  console.log(`  Index "${INDEX_NAME}" not present -- nothing to do.`);
} else {
  await collection.dropIndex(INDEX_NAME);
  console.log(`  Dropped index "${INDEX_NAME}".`);
}

console.log("");
console.log("=".repeat(78));
console.log("");

await mongoose.disconnect();
process.exit(0);
