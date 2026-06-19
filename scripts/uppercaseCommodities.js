/**
 * uppercaseCommodities.js
 * 
 * Migration script to convert all values in the 'commodities' array 
 * of the Vendors collection to uppercase.
 * 
 * Usage: node scripts/uppercaseCommodities.js
 */

import mongoose from "mongoose";
import { configDotenv } from "dotenv";

configDotenv({ quiet: true });

// Use specific connection for local DB if .env fails or as requested earlier
const MONGO_URI = "mongodb://admin:YourStrongPassword@127.0.0.1:27017/fairdesk?authSource=admin";

async function main() {
  console.log("🔗 Connecting to MongoDB...");
  try {
    await mongoose.connect(MONGO_URI);
    console.log("✅ Connected.\n");
  } catch (err) {
    console.error("❌ Connection failed:", err.message);
    process.exit(1);
  }

  const collection = mongoose.connection.collection("vendors");
  const vendors = await collection.find({}, { projection: { _id: 1, vendorName: 1, commodities: 1 } }).toArray();

  console.log(`📋 Found ${vendors.length} vendor(s) to process.\n`);

  let updated = 0;
  let skipped = 0;
  let errors = 0;

  for (const vendor of vendors) {
    const originalCommodities = vendor.commodities || [];
    
    // Check if any need conversion
    const needsUpdate = originalCommodities.some(c => c !== c.toUpperCase());

    if (!needsUpdate) {
      console.log(`⏭️  [${vendor.vendorName}] — all commodities already uppercase, skipping.`);
      skipped++;
      continue;
    }

    const uppercasedCommodities = originalCommodities.map(c => c.toUpperCase());

    try {
      await collection.updateOne(
        { _id: vendor._id },
        { $set: { commodities: uppercasedCommodities } }
      );
      console.log(`✅ [${vendor.vendorName}] — commodities converted to UPPERCASE.`);
      updated++;
    } catch (err) {
      console.error(`❌ [${vendor.vendorName}] — ERROR: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n========== DONE ==========`);
  console.log(`✅ Updated : ${updated}`);
  console.log(`⏭️  Skipped : ${skipped}`);
  console.log(`❌ Errors  : ${errors}`);
  console.log(`==========================\n`);

  await mongoose.disconnect();
  console.log("🔌 Disconnected from MongoDB.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
