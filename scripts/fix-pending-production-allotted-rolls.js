import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import PendingProduction from "../models/inventory/PendingProduction.js";

// ---------------------------------------------------------------------------
// One-time fix for PendingProduction.allottedRolls on already-assigned orders.
//
// Assign Production used to save allottedRolls as the "~ No. of Rolls"
// estimate (computed from balance qty/die) instead of the count of rolls
// actually ticked on the form (allottedRollIds.length) -- so an order with
// zero rolls physically reserved could still show as "fully allotted" (green)
// on the machine queue, and count as fully booked against paper stock. Fixed
// going forward in routes/fairdesk_route.js's POST /labels/production/assign/:id;
// this backfills every order already sitting on a machine queue so the fix
// applies without re-touching each assignment by hand.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/fix-pending-production-allotted-rolls.js           # preview
//   node scripts/fix-pending-production-allotted-rolls.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

await connectDB();

const orders = await PendingProduction.find({ assignedMachineId: { $ne: null } })
  .select("lotNo allottedRolls allottedRollIds")
  .lean();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}`);
console.log(`Assigned orders checked: ${orders.length}\n`);

let fixed = 0;
for (const order of orders) {
  const actual = Array.isArray(order.allottedRollIds) ? order.allottedRollIds.length : 0;
  if (order.allottedRolls === actual) continue;

  fixed += 1;
  console.log(`FIX      ${order.lotNo || order._id} (_id ${order._id})`);
  console.log(`           allottedRolls ${order.allottedRolls ?? "null"} -> ${actual}`);
  if (APPLY) {
    await PendingProduction.updateOne({ _id: order._id }, { $set: { allottedRolls: actual } });
  }
}

console.log(`\n${fixed} order(s) ${APPLY ? "fixed" : "would be fixed"}.`);
console.log(`\n${APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit."}`);

await PendingProduction.db.close();
process.exit(0);
