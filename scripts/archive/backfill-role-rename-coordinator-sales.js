import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", ".env") });
import connectDB from "../../config/db.js";
import Employee from "../../models/hr/employee_model.js";

// ---------------------------------------------------------------------------
// One-time migration for the role rename: the old office "sales" role is now
// called "coordinator", and the old restricted "field_sales" role is now
// called "sales" (see server.js's DEV_PERMISSIONS_BY_ROLE, the
// hasSalesAccess/hasFieldSalesAccess gates in routes/fairdesk_route.js and
// routes/users/clients.js, and isSales/isFieldSales in
// views/layout/boilerplate.ejs).
//
// Order matters: "sales" employees are moved to "coordinator" FIRST, so that
// by the time "field_sales" employees are moved to "sales" there are no
// leftover old-meaning "sales" rows to collide with.
//
// Already run and applied on 2026-08-13 (4 employees each way). Archived here
// for reference -- do NOT re-run --apply: once "field_sales" rows have been
// renamed to "sales", a second run can no longer tell them apart from
// original "sales" (coordinator) rows and would wrongly promote them.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/archive/backfill-role-rename-coordinator-sales.js          # preview
//   node scripts/archive/backfill-role-rename-coordinator-sales.js --apply  # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}`);

const oldSales = await Employee.find({ role: "sales" }, "empId empName role").lean();
console.log(`\nEmployees with role "sales" -> "coordinator": ${oldSales.length}`);
for (const e of oldSales) console.log(`  coordinator  ${e.empName} [${e.empId}] (_id ${e._id})`);
if (APPLY && oldSales.length) {
  await Employee.updateMany({ role: "sales" }, { $set: { role: "coordinator" } });
}

const oldFieldSales = await Employee.find({ role: "field_sales" }, "empId empName role").lean();
console.log(`\nEmployees with role "field_sales" -> "sales": ${oldFieldSales.length}`);
for (const e of oldFieldSales) console.log(`  sales        ${e.empName} [${e.empId}] (_id ${e._id})`);
if (APPLY && oldFieldSales.length) {
  await Employee.updateMany({ role: "field_sales" }, { $set: { role: "sales" } });
}

console.log(`\n--- Summary ---`);
console.log(`sales -> coordinator: ${oldSales.length}`);
console.log(`field_sales -> sales: ${oldFieldSales.length}`);
console.log(APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit.");

await Employee.db.close();
process.exit(0);
