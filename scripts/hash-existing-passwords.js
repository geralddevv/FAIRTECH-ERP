import mongoose from "mongoose";
import bcrypt from "bcrypt";
import { configDotenv } from "dotenv";
import Employee from "../models/hr/employee_model.js";

configDotenv();

const BATCH_SIZE = 100;

async function hashExistingPasswords() {
  try {
    await mongoose.connect(process.env.MONGO_URI);
    console.log("✓ Connected to MongoDB");

    const totalEmployees = await Employee.countDocuments();
    console.log(`Found ${totalEmployees} total employees`);

    let processed = 0;
    let hashed = 0;
    let skipped = 0;

    for (let skip = 0; skip < totalEmployees; skip += BATCH_SIZE) {
      const employees = await Employee.find().skip(skip).limit(BATCH_SIZE);

      for (const emp of employees) {
        try {
          // Check if password is already hashed (bcrypt hashes start with $2)
          if (emp.password && emp.password.startsWith("$2")) {
            console.log(`⊘ [${processed + 1}/${totalEmployees}] ${emp.empProfileCode}: Already hashed`);
            skipped++;
          } else if (emp.password) {
            const plainPassword = emp.password;
            const salt = await bcrypt.genSalt(12);
            emp.password = await bcrypt.hash(plainPassword, salt);
            await emp.save();
            console.log(`✓ [${processed + 1}/${totalEmployees}] ${emp.empProfileCode}: Hashed`);
            hashed++;
          } else {
            console.log(`⊘ [${processed + 1}/${totalEmployees}] ${emp.empProfileCode}: No password`);
            skipped++;
          }
          processed++;
        } catch (error) {
          console.error(`✗ Error processing ${emp.empProfileCode}:`, error.message);
        }
      }
    }

    console.log("\n=== Migration Summary ===");
    console.log(`Total processed: ${processed}`);
    console.log(`Newly hashed: ${hashed}`);
    console.log(`Skipped: ${skipped}`);

    await mongoose.connection.close();
    console.log("✓ Database connection closed");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  }
}

hashExistingPasswords();
