import mongoose from "mongoose";
import Employee from "./models/hr/employee_model.js";
import { configDotenv } from "dotenv";

configDotenv();

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/fairdesk";

async function initEmployeeAuth() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("Connected to MongoDB.");

    const DEFAULT_PASSWORD = "fairdesk123"; // You can change this later
    
    const result = await Employee.updateMany(
      { password: { $exists: false } },
      { 
        $set: { 
          password: DEFAULT_PASSWORD,
          role: "employee",
          permissions: {
            sales: false,
            inventory: false,
            hr: false,
            accounting: false,
            master: false
          }
        } 
      }
    );

    console.log(`Updated ${result.modifiedCount} employees with default password and permissions.`);
    
    // Also ensure existing hardcoded roles have full permissions if they exist as employees
    // For now, this is enough to let them in.

    process.exit(0);
  } catch (error) {
    console.error("Error updating employees:", error);
    process.exit(1);
  }
}

initEmployeeAuth();
