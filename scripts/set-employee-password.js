import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import Employee from "../models/hr/employee_model.js";
import readline from "readline";

// ---------------------------------------------------------------------------
// Set password for an employee by empId.
//
// Usage:
//   node scripts/set-employee-password.js --empId="FS | EMPLOYEE | 054"
//   node scripts/set-employee-password.js --empId="FS | EMPLOYEE | 054" --password="newpassword"
//
// If --password is not provided, you will be prompted interactively to enter it.
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
let empId = null;
let password = null;

for (const arg of args) {
  if (arg.startsWith("--empId=")) {
    empId = arg.substring("--empId=".length);
  } else if (arg.startsWith("--password=")) {
    password = arg.substring("--password=".length);
  }
}

if (!empId) {
  console.error("Error: --empId is required");
  console.error("Usage: node scripts/set-employee-password.js --empId=\"FS | EMPLOYEE | 054\" [--password=\"newpassword\"]");
  process.exit(1);
}

await connectDB();

const employee = await Employee.findOne({ empId });

if (!employee) {
  console.error(`Error: Employee with empId "${empId}" not found`);
  await mongoose.disconnect();
  process.exit(1);
}

console.log("");
console.log("=".repeat(78));
console.log(`  SET EMPLOYEE PASSWORD`);
console.log("=".repeat(78));
console.log("");
console.log(`  Employee ID: ${empId}`);
console.log(`  Name: ${employee.empName}`);
console.log(`  Email: ${employee.empEmail}`);
console.log("");

if (!password) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  password = await new Promise((resolve) => {
    rl.question("  Enter new password: ", (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

if (!password || password.trim() === "") {
  console.error("Error: Password cannot be empty");
  await mongoose.disconnect();
  process.exit(1);
}

employee.password = password;
await employee.save();

console.log("  Password updated successfully.");
console.log("");
console.log("=".repeat(78));
console.log("");

await mongoose.disconnect();
process.exit(0);
