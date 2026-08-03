import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import PendingProduction from "../models/inventory/PendingProduction.js";
// Registered (not referenced directly) so populate() can resolve
// PendingProduction's userId (-> Username) and itemId (refPath onModel,
// Label | ColorLabel) refs.
import "../models/users/username.js";
import "../models/inventory/labels.js";
import "../models/inventory/colorLabel.js";
import "../models/system/machine.js";
import "../models/hr/employee_model.js";

// ---------------------------------------------------------------------------
// Delete a single production-queue row (the underlying PendingProduction
// document) shown on /fairtech/labels/production/pending?tab=wip.
//
// Matches by the human-readable details from that page rather than an internal
// id -- Client name + User name + Product Id + Quantity -- and refuses to
// delete unless the match is unambiguous. Pass --id <orderId> to target one
// exact document instead (the PendingProduction _id == the source order _id).
//
// Dry-run by default. Pass --apply to actually delete.
//
//   node scripts/remove-wip-production.js                 # preview default target
//   node scripts/remove-wip-production.js --apply         # delete it
//   node scripts/remove-wip-production.js --id <orderId>          # preview one exact doc
//   node scripts/remove-wip-production.js --id <orderId> --apply  # delete that exact doc
//   node scripts/remove-wip-production.js --client "X" --user "Y" --product 123 --qty 30000
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const flag = (name) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] ? args[i + 1] : null;
};

// Defaults are the specific row requested for removal.
const targetId = flag("--id");
const client = (flag("--client") || "LUPIN LIMITED").trim();
const user = (flag("--user") || "SURAJ SHINDE").trim();
const product = (flag("--product") || "108653").trim();
const qtyArg = flag("--qty") || "30000";
const qty = Number(qtyArg);

const norm = (v) => String(v ?? "").trim().toUpperCase();

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (will delete)" : "DRY-RUN (no changes)"}\n`);

const rows = await PendingProduction.find({})
  .populate({ path: "userId", select: "clientName userName clientType" })
  .populate({ path: "itemId", select: "productId clientName userName" })
  .populate({ path: "assignedMachineId", select: "machineName" })
  .populate({ path: "operatorId", select: "empName" })
  .populate({ path: "helperId", select: "empName" })
  .lean();

let matches;
if (targetId) {
  if (!mongoose.isValidObjectId(targetId)) {
    console.error(`Invalid --id: ${targetId}`);
    await mongoose.disconnect();
    process.exit(1);
  }
  matches = rows.filter((r) => String(r._id) === String(targetId));
} else {
  matches = rows.filter((r) => {
    const clientName = r.userId?.clientName || r.itemId?.clientName || "";
    const userName = r.userId?.userName || r.itemId?.userName || "";
    const productId = r.itemId?.productId || "";
    return (
      norm(clientName) === norm(client) &&
      norm(userName) === norm(user) &&
      norm(productId) === norm(product) &&
      Number(r.quantity) === qty
    );
  });
  console.log(
    `Searching by: Client="${client}"  User="${user}"  Product="${product}"  Qty=${qty}\n`,
  );
}

if (!matches.length) {
  console.log("No matching production row found. Nothing to delete.");
  await mongoose.disconnect();
  process.exit(0);
}

const describe = (r) => {
  console.log(`  _id            ${r._id}`);
  console.log(`  onModel        ${r.onModel}`);
  console.log(`  client / user  ${r.userId?.clientName || "N/A"} / ${r.userId?.userName || "N/A"}`);
  console.log(`  productId      ${r.itemId?.productId || "N/A"}`);
  console.log(`  quantity       ${r.quantity}  (dispatched ${r.dispatchedQuantity || 0})`);
  console.log(`  machine        ${r.assignedMachineId?.machineName || "— (not WIP)"}`);
  console.log(`  operator       ${r.operatorId?.empName || "—"}`);
  console.log(`  helper         ${r.helperId?.empName || "—"}`);
  console.log(`  lotNo          ${r.lotNo || "—"}`);
  console.log(`  assignedAt     ${r.assignedAt ? new Date(r.assignedAt).toLocaleString("en-IN") : "—"}`);
  console.log(`  producedAt     ${r.producedAt ? new Date(r.producedAt).toLocaleString("en-IN") : "—"}`);
  console.log(`  allottedRolls  ${(r.allottedRollIds || []).length} reel(s)`);
};

console.log(`Matched ${matches.length} row(s):\n`);
matches.forEach((r) => { describe(r); console.log(""); });

if (matches.length > 1) {
  console.error("More than one row matched -- refusing to delete for safety.");
  console.error("Re-run with --id <_id> (shown above) to target exactly one.");
  await mongoose.disconnect();
  process.exit(1);
}

const target = matches[0];

// A job card already filed (producedAt) or reels allotted means stock may have
// been touched -- deleting this row does NOT reverse any stock movement. Warn,
// but proceed: the request is an explicit removal.
if (target.producedAt || (target.allottedRollIds || []).length) {
  console.log(
    "NOTE: this row has a filed Job Card and/or allotted reels. Deleting it does",
  );
  console.log(
    "      not reverse any paper-stock deduction -- adjust stock separately if needed.\n",
  );
}

if (APPLY) {
  await PendingProduction.deleteOne({ _id: target._id });
  console.log(`DELETED PendingProduction ${target._id}.`);
  console.log("Note: the source sales order (same _id) is untouched. If that order is");
  console.log("still PENDING, a later edit could re-create this queue row.");
} else {
  console.log("Dry-run only. Re-run with --apply to delete this row.");
}

await mongoose.disconnect();
process.exit(0);
