import mongoose from "mongoose";
import Employee from "../../models/hr/employee_model.js";
import { configDotenv } from "dotenv";

configDotenv();

const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/fairdesk";

async function resetAllEmployeePasswords() {
  try {
    await mongoose.connect(MONGO_URI);
    console.log("Connected to MongoDB.");

    const NEW_PASSWORD = "pass"; 
    
    // Update EVERY employee record
    const result = await Employee.updateMany(
      {}, // Empty filter to match all documents
      { 
        $set: { 
          password: NEW_PASSWORD
        } 
      }
    );

    console.log(`Successfully updated ${result.modifiedCount} employees. Every employee password is now set to "${NEW_PASSWORD}".`);
    
    process.exit(0);
  } catch (error) {
    console.error("Error updating employee passwords:", error);
    process.exit(1);
  }
}

resetAllEmployeePasswords();
