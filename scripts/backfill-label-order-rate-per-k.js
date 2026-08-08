import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import LabelSalesOrder from "../models/inventory/LabelSalesOrder.js";
import ColorLabelSalesOrder from "../models/inventory/ColorLabelSalesOrder.js";
import PendingProduction from "../models/inventory/PendingProduction.js";

// ---------------------------------------------------------------------------
// Normalise legacy Label / Color Label sales orders to a per-1000 order rate.
//
// The sales order form used to take a label order's rate from the binding's
// `ratePerLabel` -- (Rate Per 1000 - commission) / 1000, i.e. Our Amount Per
// 1000 expressed per single label. It now takes the binding's gross
// `ratePerK` ("Rate Per 1000") instead, and stamps `orderRateUnit: "PER_K"` on
// the order so every order-value calc divides by 1000 (quantity is in labels).
//
// Orders placed before that switch hold a per-label rate and no orderRateUnit.
// Nothing is broken while they stay that way -- a missing unit is read as
// PER_LABEL everywhere and their values still come out right -- so this script
// is optional. Run it when you want every label order's Rate column to read on
// the same per-1000 scale.
//
// What it does per order: orderRate * 1000, and set orderRateUnit "PER_K".
// The rate is NOT re-derived from the binding, so a rate that was hand-edited
// on the order (Curr Rate) keeps its own value -- only its scale changes.
//
// Note the converted number stays net of commission, since that is what the
// old field held; it will not match the binding's gross Rate Per 1000 exactly.
// Converting cannot recover a commission that was never stored on the order.
//
// Idempotent: only orders with no orderRateUnit at all are touched, and each
// converted order gets the field, so a second run finds nothing.
//
// Dry-run by default -- pass --apply to commit.
//
//   node scripts/backfill-label-order-rate-per-k.js           # preview
//   node scripts/backfill-label-order-rate-per-k.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.slice(2).includes("--apply");

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

// A legacy order simply has no orderRateUnit stored (the schema deliberately
// gives it no default, so nothing fabricates one on read).
const legacyQuery = { orderRateUnit: { $exists: false } };

let grandTotal = 0;

for (const [name, Model] of [
  ["Label", LabelSalesOrder],
  ["Color Label", ColorLabelSalesOrder],
]) {
  const orders = await Model.find(legacyQuery)
    .select("_id poNumber quantity orderRate status createdAt")
    .sort({ createdAt: 1 })
    .lean();

  console.log(`${name}: ${orders.length} order(s) on the old per-label rate.`);

  for (const order of orders) {
    const oldRate = Number(order.orderRate) || 0;
    const newRate = oldRate * 1000;
    const created = order.createdAt ? new Date(order.createdAt).toLocaleDateString("en-GB") : "N/A";
    console.log(
      `  ${order._id}  ${created}  PO ${order.poNumber || "N/A"}  ${order.status}` +
        `  qty ${order.quantity}  rate ${oldRate} -> ${newRate} per 1000`,
    );

    if (APPLY) {
      await Model.updateOne(
        { _id: order._id },
        { $set: { orderRate: newRate, orderRateUnit: "PER_K" } },
      );
    }
  }

  grandTotal += orders.length;
  console.log("");
}

// PendingProduction copies orderRate off the order when one is created or
// edited (utils/pendingProduction.js). Nothing reads that copy for money today,
// but leave the two consistent rather than half-converted.
const pendingRows = await PendingProduction.find({
  onModel: { $in: ["Label", "ColorLabel"] },
  orderRateUnit: { $exists: false },
})
  .select("_id orderId orderRate")
  .lean();

console.log(`PendingProduction: ${pendingRows.length} row(s) carrying an old per-label rate.`);
if (APPLY) {
  for (const row of pendingRows) {
    await PendingProduction.updateOne(
      { _id: row._id },
      { $set: { orderRate: (Number(row.orderRate) || 0) * 1000, orderRateUnit: "PER_K" } },
    );
  }
}

console.log(
  `\n${grandTotal} sales order(s) ${APPLY ? "converted" : "would be converted"}.` +
    `${APPLY ? "" : " Dry-run only -- re-run with --apply to commit."}`,
);

await mongoose.disconnect();
process.exit(0);
