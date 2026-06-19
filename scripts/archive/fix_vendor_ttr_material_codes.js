/**
 * Migration: Fix swapped FS/vendor fields in vendor TTR records.
 *
 * OLD (wrong) logic:
 *   Ttr.ttrMaterialCode / ttrType = vendor values
 *   VendorTtrBinding.vendorTtrMaterialCode / vendorTtrType = FS values
 *
 * NEW (correct) logic:
 *   Ttr.ttrMaterialCode / ttrType = FS values
 *   VendorTtrBinding.vendorTtrMaterialCode / vendorTtrType = vendor values
 *
 * This script swaps the recoverable fields for existing records.
 */

import mongoose from "mongoose";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const MONGO_URI = process.env.MONGO_URI || process.env.DB_URI || process.env.MONGODB_URI;
if (!MONGO_URI) {
  console.error("No MongoDB URI found in .env (tried MONGO_URI, DB_URI, MONGODB_URI)");
  process.exit(1);
}

// ── Minimal inline schemas (avoids importing full models) ─────────────────────
const ttrSchema = new mongoose.Schema({ ttrMaterialCode: String, ttrType: String }, { strict: false });
const bindingSchema = new mongoose.Schema(
  {
    vendorUserId: mongoose.Schema.Types.ObjectId,
    ttrId: mongoose.Schema.Types.ObjectId,
    vendorTtrMaterialCode: String,
    vendorTtrType: String,
  },
  { strict: false },
);

const Ttr = mongoose.model("Ttr", ttrSchema);
const VendorTtrBinding = mongoose.model("VendorTtrBinding", bindingSchema);

async function run() {
  const uri = MONGO_URI.replace("localhost", "127.0.0.1");
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 3000 });
  console.log("Connected to MongoDB");

  const bindings = await VendorTtrBinding.find({}).lean();
  console.log(`Found ${bindings.length} VendorTtrBinding record(s) to process`);

  let swapped = 0;
  let skipped = 0;

  for (const binding of bindings) {
    const ttr = await Ttr.findById(binding.ttrId).lean();
    if (!ttr) {
      console.warn(`Ttr not found for binding ${binding._id} — skipping`);
      skipped++;
      continue;
    }

    const oldFsMaterialCode = binding.vendorTtrMaterialCode; // was FS code (wrong field)
    const oldVendorMaterialCode = ttr.ttrMaterialCode; // was vendor code (wrong field)
    const oldFsType = binding.vendorTtrType;
    const oldVendorType = ttr.ttrType;

    if (oldFsMaterialCode === oldVendorMaterialCode && oldFsType === oldVendorType) {
      // Values are the same — no visible change, skip to avoid unnecessary writes
      skipped++;
      continue;
    }

    // Swap the recoverable fields.
    await Ttr.updateOne(
      { _id: ttr._id },
      {
        $set: {
          ttrMaterialCode: oldFsMaterialCode,
          ttrType: oldFsType,
        },
      },
    );
    await VendorTtrBinding.updateOne(
      { _id: binding._id },
      {
        $set: {
          vendorTtrMaterialCode: oldVendorMaterialCode,
          vendorTtrType: oldVendorType,
        },
      },
    );

    console.log(
      `Binding ${binding._id}: ` +
        `Ttr.ttrMaterialCode ${oldVendorMaterialCode} → ${oldFsMaterialCode} | ` +
        `Ttr.ttrType ${oldVendorType} → ${oldFsType} | ` +
        `vendorTtrMaterialCode ${oldFsMaterialCode} → ${oldVendorMaterialCode} | ` +
        `vendorTtrType ${oldFsType} → ${oldVendorType}`,
    );
    swapped++;
  }

  console.log(`\n  Done — swapped: ${swapped}, skipped: ${skipped}`);
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
