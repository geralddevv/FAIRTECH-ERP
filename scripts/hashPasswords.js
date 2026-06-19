/**
 * hashPasswords.js
 *
 * One-time migration script to hash all plain-text passwords
 * in the Employee collection. Safe to run multiple times —
 * it detects already-hashed passwords and skips them.
 *
 * Usage: node scripts/hashPasswords.js
 */

import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { configDotenv } from "dotenv";

configDotenv({ quiet: true });

const SALT_ROUNDS = 12;
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/fairdesk";

async function main() {
  console.log("🔗 Connecting to MongoDB...");
  await mongoose.connect("mongodb://admin:YourStrongPassword@127.0.0.1:27017/fairdesk?authSource=admin");
  console.log("✅ Connected.\n");

  // Use the raw collection to bypass the pre-save hook (avoids double-hashing)
  const collection = mongoose.connection.collection("employees");

  const employees = await collection.find({}, { projection: { _id: 1, empId: 1, empName: 1, password: 1 } }).toArray();

  console.log(`📋 Found ${employees.length} employee(s) to process.\n`);

  let hashed = 0;
  let skipped = 0;
  let errors = 0;

  for (const emp of employees) {
    const pw = emp.password;

    // bcrypt hashes always start with $2b$ or $2a$ — skip if already hashed
    if (pw && (pw.startsWith("$2b$") || pw.startsWith("$2a$"))) {
      console.log(`⏭️  [${emp.empId || emp._id}] ${emp.empName || "Unknown"} — already hashed, skipping.`);
      skipped++;
      continue;
    }

    if (!pw) {
      console.log(`⚠️  [${emp.empId || emp._id}] ${emp.empName || "Unknown"} — no password set, skipping.`);
      skipped++;
      continue;
    }

    try {
      const hashedPw = await bcrypt.hash(pw, SALT_ROUNDS);
      await collection.updateOne({ _id: emp._id }, { $set: { password: hashedPw } });
      console.log(`✅ [${emp.empId || emp._id}] ${emp.empName || "Unknown"} — password hashed.`);
      hashed++;
    } catch (err) {
      console.error(`❌ [${emp.empId || emp._id}] ${emp.empName || "Unknown"} — ERROR: ${err.message}`);
      errors++;
    }
  }

  console.log(`\n========== DONE ==========`);
  console.log(`✅ Hashed  : ${hashed}`);
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
