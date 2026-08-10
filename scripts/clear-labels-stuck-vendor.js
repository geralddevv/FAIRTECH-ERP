import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import Label from "../models/inventory/labels.js";

// ---------------------------------------------------------------------------
// Clear Label bindings (/fairtech/labels-binding/edit/:id) whose Vendor Name
// is stuck on "ALL TECH SOLUTIONS" -- see
// scripts/report-labels-missing-vendor.js for the full explanation. In short:
// that value is not something anyone typed. It is the alphabetically-first
// row in Vendor Master, and a binding got stamped with it purely by opening
// and saving the edit form while its Vendor Name was blank -- a bug in the
// form's placeholder <option> (missing `selected`) combined with an unsorted,
// unscoped vendor list. Both are now fixed at the source (routes and views),
// so this script is a one-time cleanup of records that already got hit.
//
// This clears vendorName back to null on exactly those bindings -- matching
// how every other blank-vendor binding is already stored (see
// report-labels-missing-vendor.js: null, not "" and not a missing field). It
// does NOT try to guess what the real vendor should have been; that value was
// destroyed the moment the bug wrote over it, and this script only removes a
// wrong value, it doesn't invent a correct one.
//
// DRY RUN BY DEFAULT. Pass --apply to actually write.
//
//   node scripts/clear-labels-stuck-vendor.js            # preview only
//   node scripts/clear-labels-stuck-vendor.js --apply    # commit the clear
// ---------------------------------------------------------------------------

const STUCK_VENDOR = "ALL TECH SOLUTIONS";
const APPLY = process.argv.includes("--apply");

await connectDB();

const stuck = await Label.find({ vendorName: STUCK_VENDOR })
  .select("clientName userName location productId jobName")
  .lean();

console.log("");
console.log("=".repeat(78));
console.log(`  CLEAR LABEL BINDINGS STUCK ON VENDOR "${STUCK_VENDOR}"`);
console.log("=".repeat(78));
console.log("");
console.log(`  Mode: ${APPLY ? "APPLY -- writing to the database" : "DRY RUN -- no changes will be made (pass --apply to commit)"}`);
console.log(`  Bindings matched: ${stuck.length}`);
console.log("");

if (!stuck.length) {
  console.log("  Nothing to do.");
} else {
  for (const b of stuck) {
    console.log(`  ${b.clientName || "—"} / ${b.userName || "—"}  (${b.location || "—"})`);
    console.log(`     product ${b.productId || "—"}  |  job ${b.jobName || "—"}`);
    console.log(`     /fairtech/labels-binding/edit/${b._id}`);
    console.log("");
  }

  if (APPLY) {
    const result = await Label.updateMany(
      { vendorName: STUCK_VENDOR },
      { $set: { vendorName: null } },
    );
    console.log(`  Updated ${result.modifiedCount} of ${stuck.length} matched bindings.`);
  } else {
    console.log(`  DRY RUN -- ${stuck.length} binding(s) would be cleared. Re-run with --apply to commit.`);
  }
}

console.log("");
console.log("=".repeat(78));
console.log("");

await mongoose.disconnect();
process.exit(0);
