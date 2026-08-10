import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import Label from "../models/inventory/labels.js";

// ---------------------------------------------------------------------------
// Report: Label bindings (/fairtech/labels-binding/edit/:id) whose Vendor
// Name is blank, or is stuck on "ALL TECH SOLUTIONS".
//
// READ-ONLY. This script never writes to the database.
//
// "ALL TECH SOLUTIONS" is not a placeholder value someone typed on purpose --
// it is the alphabetically-first row in Vendor Master. The edit form's Vendor
// Name <select> used to leave its blank placeholder <option> without
// `selected`, so on any binding with no vendor, the browser fell back to
// selecting the first non-disabled <option> in DOM order on its own -- which,
// because the form built its option list with an unsorted, unscoped
// Vendor.distinct("vendorName"), was whichever vendor sorted first
// alphabetically: "ALL TECH SOLUTIONS". Reopening a blank-vendor binding and
// saving it (even without touching that field) would silently stamp that
// vendor onto the record. Both bugs are now fixed (see CLAUDE.md history /
// the routes+views change), so this report is a one-time cleanup list of
// records affected before the fix, not an ongoing symptom.
//
// A blank vendorName by itself is NOT necessarily a problem -- Vendor Name on
// this form has always been optional. It's listed here so you can see the
// full population and decide, not because every blank is wrong.
//
//   node scripts/report-labels-missing-vendor.js                # full report
//   node scripts/report-labels-missing-vendor.js --stuck-only    # only the ALL TECH SOLUTIONS rows
//   node scripts/report-labels-missing-vendor.js --csv=out.csv
// ---------------------------------------------------------------------------

const STUCK_VENDOR = "ALL TECH SOLUTIONS";

const args = process.argv.slice(2);
const STUCK_ONLY = args.includes("--stuck-only");
const csvArg = args.find((a) => a.startsWith("--csv="));
const CSV_PATH = csvArg ? csvArg.slice("--csv=".length) : null;

await connectDB();

const bindings = await Label.find({})
  .select("clientName userName location productId jobName vendorName status createdAt")
  .sort({ clientName: 1, userName: 1 })
  .lean();

const blank = bindings.filter((b) => !String(b.vendorName || "").trim());
const stuck = bindings.filter((b) => String(b.vendorName || "").trim() === STUCK_VENDOR);

const rows = STUCK_ONLY ? stuck : [...blank, ...stuck];

console.log("");
console.log("=".repeat(78));
console.log("  LABEL BINDINGS -- MISSING OR STUCK VENDOR NAME");
console.log("=".repeat(78));
console.log("");
console.log(`  Total Label bindings           : ${bindings.length}`);
console.log(`    vendor blank/missing         : ${blank.length}`);
console.log(`    vendor = "${STUCK_VENDOR}"    : ${stuck.length}`);
console.log("");

function printGroup(title, list) {
  console.log("-".repeat(78));
  console.log(`  ${title} (${list.length})`);
  console.log("-".repeat(78));
  if (!list.length) {
    console.log("  None.");
    console.log("");
    return;
  }
  for (const b of list) {
    console.log(`  ${b.clientName || "—"} / ${b.userName || "—"}  (${b.location || "—"})`);
    console.log(`     product ${b.productId || "—"}  |  job ${b.jobName || "—"}  |  status ${b.status || "—"}`);
    console.log(`     /fairtech/labels-binding/edit/${b._id}`);
    console.log("");
  }
}

if (!STUCK_ONLY) printGroup("VENDOR BLANK / MISSING", blank);
printGroup(`VENDOR STUCK ON "${STUCK_VENDOR}"`, stuck);

if (CSV_PATH) {
  const esc = (v) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["bindingId", "issue", "clientName", "userName", "location", "productId", "jobName", "status", "editUrl"];
  const lines = [header.join(",")];
  for (const b of rows) {
    const issue = String(b.vendorName || "").trim() === STUCK_VENDOR ? "STUCK_ON_ALL_TECH_SOLUTIONS" : "BLANK";
    lines.push([
      String(b._id), issue, b.clientName, b.userName, b.location, b.productId, b.jobName, b.status,
      `/fairtech/labels-binding/edit/${b._id}`,
    ].map(esc).join(","));
  }
  fs.writeFileSync(path.resolve(CSV_PATH), lines.join("\n") + "\n", "utf8");
  console.log(`  CSV written: ${path.resolve(CSV_PATH)}  (${lines.length - 1} rows)`);
  console.log("");
}

console.log("=".repeat(78));
console.log("  Read-only report. Nothing was written to the database.");
console.log("=".repeat(78));
console.log("");

await mongoose.disconnect();
process.exit(0);
