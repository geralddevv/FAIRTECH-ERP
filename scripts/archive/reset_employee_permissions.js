import mongoose from "mongoose";
import Employee from "../../models/hr/employee_model.js";
import dotenv from "dotenv";

dotenv.config();

async function resetPermissions() {
  try {
    console.log("Connecting to database...");
    const mongoUri = process.env.MONGO_URI || "mongodb://localhost:27017/fairdesk";
    await mongoose.connect(mongoUri);
    console.log("Database connected.");

    console.log("Resetting all employee roles and permissions...");
    
    const result = await Employee.updateMany(
      {}, // Target all employees
      { 
        $set: { 
          role: "none",
          "permissions.sales": false,
          "permissions.inventory": false,
          "permissions.hr": false,
          "permissions.accounting": false,
          "permissions.master": false,
          canRead: false,
          canWrite: false,
          canDelete: false
        } 
      }
    );

    console.log(`Successfully updated ${result.modifiedCount} employees.`);
    console.log("All employees have been set to 'none' role with no access.");
    
    process.exit(0);
  } catch (err) {
    console.error("Reset failed:", err);
    process.exit(1);
  }
}

resetPermissions();
