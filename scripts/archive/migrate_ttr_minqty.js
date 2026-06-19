import mongoose from "mongoose";
import VendorTtrBinding from "./models/inventory/vendorTtrBinding.js";
import Ttr from "./models/inventory/ttr.js";
import connectDB from "./config/db.js";
import { configDotenv } from "dotenv";

configDotenv({ quiet: true });

async function migrate() {
  await connectDB();
  console.log("Connected to DB");

  const bindings = await VendorTtrBinding.find({}).lean();
  console.log(`Found ${bindings.length} bindings.`);

  let updatedCount = 0;
  for (const binding of bindings) {
    if (binding.ttrId && binding.ttrMinQty) {
      const res = await Ttr.updateOne(
        { _id: binding.ttrId, ttrMinQty: { $exists: false } }, // Only if not already set or we want to overwrite
        { $set: { ttrMinQty: binding.ttrMinQty } }
      );
      if (res.modifiedCount > 0) updatedCount++;
    }
  }

  console.log(`Updated ${updatedCount} TTR master records.`);
  process.exit(0);
}

migrate().catch(err => {
  console.error(err);
  process.exit(1);
});
