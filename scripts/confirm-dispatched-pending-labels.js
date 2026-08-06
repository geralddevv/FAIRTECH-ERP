import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import LabelSalesOrder from "../models/inventory/LabelSalesOrder.js";
import SalesOrderLog from "../models/inventory/SalesOrderLog.js";
import { removePendingProduction } from "../utils/pendingProduction.js";
import "../models/users/username.js"; // registers Username model for populate

// ---------------------------------------------------------------------------
// Confirm Label sales orders that are fully dispatched but stuck at PENDING.
//
// Label orders are never stock-tracked: dispatching one writes a DELIVERED
// SalesOrderLog and bumps `dispatchedQuantity` (POST /sales/order/status, the
// `onModel === "Label"` branch). Once `dispatchedQuantity >= quantity` that
// same handler flips the order to CONFIRMED and removes its PendingProduction
// row, dropping it off /fairtech/labels/sales/pending.
//
// A handful of orders got their DELIVERED log + dispatchedQuantity written but
// never made that final status flip -- so they read as fully dispatched (or
// over-dispatched) yet still sit on the Pending Label Orders page with a
// lingering PendingProduction row. This finishes the job the confirm handler
// would have: it flips each stuck order to CONFIRMED, deletes its leftover
// PendingProduction, and drops a CONFIRMED SalesOrderLog line so the fix is
// recorded in the order's own log alongside the original DELIVERED entry.
//
// The dispatch itself is NOT re-logged and quantities are NOT touched -- the
// DELIVERED log and dispatchedQuantity already on the order are the source of
// truth and stay exactly as they are.
//
// Match condition (mirrors the handler's own rule): onModel Label, status
// PENDING, and dispatchedQuantity >= quantity. Partially dispatched orders
// (dispatchedQuantity < quantity) are genuinely pending and left untouched.
//
// Dry-run by default -- pass --apply to commit.
//
//   node scripts/confirm-dispatched-pending-labels.js                 # preview all
//   node scripts/confirm-dispatched-pending-labels.js --apply          # commit
//   node scripts/confirm-dispatched-pending-labels.js <orderId>        # preview one order
//   node scripts/confirm-dispatched-pending-labels.js <orderId> --apply # commit one order
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const orderFilter = args.find((a) => a !== "--apply" && mongoose.isValidObjectId(a));

await connectDB();

console.log(
  `Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}` +
    `${orderFilter ? ` -- order ${orderFilter}` : " -- all fully-dispatched pending label orders"}\n`,
);

const query = {
  onModel: "Label",
  status: "PENDING",
  $expr: { $gte: [{ $ifNull: ["$dispatchedQuantity", 0] }, "$quantity"] },
};
if (orderFilter) query._id = new mongoose.Types.ObjectId(orderFilter);

const stuck = await LabelSalesOrder.find(query)
  .populate({ path: "userId", select: "clientName" })
  .sort({ createdAt: 1 })
  .lean();

if (!stuck.length) {
  console.log("No fully-dispatched PENDING label orders found. Nothing to do.");
  await mongoose.disconnect();
  process.exit(0);
}

console.log(`Found ${stuck.length} fully-dispatched PENDING label order(s):\n`);

let fixed = 0;
for (const order of stuck) {
  const client = order.userId?.clientName || "UNKNOWN CLIENT";
  const poDate = order.poDate ? new Date(order.poDate).toLocaleDateString("en-GB") : "N/A";

  // The dispatch(es) already logged -- shown for context; never rewritten.
  const dispatchLogs = await SalesOrderLog.find({ orderId: order._id, action: { $in: ["DELIVERED", "PRECLOSE"] } })
    .sort({ performedAt: 1 })
    .lean();
  const lastDispatch = dispatchLogs[dispatchLogs.length - 1];

  console.log(`${order._id}  ${poDate}  ${order.poNumber || "N/A"}  ${client}`);
  console.log(`  quantity ${order.quantity}  dispatched ${order.dispatchedQuantity || 0}  (${dispatchLogs.length} dispatch log entr${dispatchLogs.length === 1 ? "y" : "ies"})`);
  console.log(`  -> set status CONFIRMED, remove PendingProduction, add CONFIRMED log`);

  fixed += 1;

  if (APPLY) {
    await LabelSalesOrder.findByIdAndUpdate(order._id, { status: "CONFIRMED" });
    await removePendingProduction(order._id);
    await SalesOrderLog.create({
      orderId: order._id,
      action: "CONFIRMED",
      // Carry the dispatch's invoice forward for the audit trail; the dispatch
      // quantity itself is already captured by the original DELIVERED log.
      invoiceNumber: lastDispatch?.invoiceNumber || "",
      quantity: order.dispatchedQuantity || order.quantity,
      performedBy: "SYSTEM (cleanup: confirm-dispatched-pending-labels)",
      performedAt: new Date(),
    });
    console.log(`  APPLIED.`);
  }
  console.log("");
}

console.log(
  `${fixed} order(s) ${APPLY ? "confirmed" : "would be confirmed"}.` +
    `${APPLY ? "" : " Dry-run only -- re-run with --apply to commit."}`,
);

await mongoose.disconnect();
process.exit(0);
