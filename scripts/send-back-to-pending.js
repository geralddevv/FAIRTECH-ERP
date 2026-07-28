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

// ---------------------------------------------------------------------------
// Send WIP production order(s) back to Pending -- the same action as the
// "Send Back to Pending" button on /fairtech/labels/production/pending?tab=wip
// (POST /fairtech/labels/production/unassign/:id), runnable from the command
// line without opening the UI.
//
// Clears the machine/operator/helper assignment and allotted rolls so the
// order drops back into the Pending tab. lotNo is kept -- same reasoning as
// the route: it's tied to the order's life, not to any one assignment, so a
// later re-assignment picks up the same lot rather than a fresh one.
//
// Refuses any order that already has a Job Card filed (producedAt set) --
// by then reels may already be deducted, so unwinding the assignment isn't
// safe; cancel the order instead if it needs to stop. In --all mode this
// just skips such orders (with a count in the summary) rather than aborting
// the whole run.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/send-back-to-pending.js <orderId>            # preview one
//   node scripts/send-back-to-pending.js <orderId> --apply    # commit one
//   node scripts/send-back-to-pending.js --all                # preview every WIP order
//   node scripts/send-back-to-pending.js --all --apply        # commit every WIP order
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const ALL = args.includes("--all");
const orderId = args.find((a) => a !== "--apply" && a !== "--all");

if (!ALL && (!orderId || !mongoose.isValidObjectId(orderId))) {
  console.error("Usage: node scripts/send-back-to-pending.js <orderId> [--apply]");
  console.error("       node scripts/send-back-to-pending.js --all [--apply]");
  process.exit(1);
}

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}${ALL ? " -- ALL WIP orders" : ""}\n`);

// Sends one order back to Pending. Returns "sent" | "skip-not-assigned" |
// "refused-job-card" so the bulk path can tally a summary instead of exiting.
async function processOrder(order) {
  const label = `${order.itemId?.productId || order._id} (${order.userId?.clientName || "N/A"}, PO ${order.poNumber || "N/A"})`;

  if (!order.assignedMachineId) {
    console.log(`SKIP     ${label}`);
    console.log("           Not assigned to a machine -- already in Pending.");
    return "skip-not-assigned";
  }

  if (order.producedAt) {
    console.log(`REFUSED  ${label}`);
    console.log("           A Job Card has already been filed for this order -- can't send it back");
    console.log("           to Pending. Cancel it instead if it needs to stop.");
    return "refused-job-card";
  }

  console.log(`UNASSIGN ${label}`);
  console.log(`           assignedMachineId ${order.assignedMachineId} -> null`);
  console.log(`           operatorId        ${order.operatorId || "—"} -> null`);
  console.log(`           helperId          ${order.helperId || "—"} -> null`);
  console.log(`           allottedRollIds   ${(order.allottedRollIds || []).length} roll(s) -> []`);
  console.log(`           lotNo             ${order.lotNo || "—"} (kept)`);

  if (APPLY) {
    await PendingProduction.findByIdAndUpdate(order._id, {
      $set: { assignedMachineId: null, operatorId: null, helperId: null, allottedRollIds: [] },
      $unset: { allottedRolls: "", assignedAt: "", productionBindingId: "" },
    });
  }

  return "sent";
}

if (ALL) {
  const orders = await PendingProduction.find({ assignedMachineId: { $ne: null } })
    .populate({ path: "userId", select: "clientName userName" })
    .populate({ path: "itemId", select: "productId" })
    .lean();

  console.log(`WIP orders found: ${orders.length}\n`);

  const tally = { sent: 0, "skip-not-assigned": 0, "refused-job-card": 0 };
  for (const order of orders) {
    const result = await processOrder(order);
    tally[result]++;
    console.log("");
  }

  console.log(
    `${APPLY ? "Sent" : "Would send"} ${tally.sent} back to Pending, ` +
      `${tally["refused-job-card"]} refused (Job Card already filed), ` +
      `${tally["skip-not-assigned"]} already not assigned.`,
  );
  if (!APPLY && tally.sent) console.log("Dry-run only. Re-run with --apply to commit.");
} else {
  const order = await PendingProduction.findById(orderId)
    .populate({ path: "userId", select: "clientName userName" })
    .populate({ path: "itemId", select: "productId" })
    .lean();

  if (!order) {
    console.error(`Order not found: ${orderId}`);
    await mongoose.disconnect();
    process.exit(1);
  }

  const result = await processOrder(order);
  console.log("");
  if (result === "sent") {
    console.log(APPLY ? "Order sent back to Pending." : "Dry-run only. Re-run with --apply to commit.");
  }
  if (result === "refused-job-card") {
    await mongoose.disconnect();
    process.exit(1);
  }
}

await mongoose.disconnect();
process.exit(0);
