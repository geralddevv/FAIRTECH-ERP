import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import LabelSalesOrder from "../models/inventory/LabelSalesOrder.js";
import ColorLabelSalesOrder from "../models/inventory/ColorLabelSalesOrder.js";
import PendingProduction from "../models/inventory/PendingProduction.js";
import { upsertPendingProduction } from "../utils/pendingProduction.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * One-time backfill: the "Pending Production" page used to compute its list
 * live from LabelSalesOrder/ColorLabelSalesOrder (filtered to status
 * PENDING) every time it was loaded. It's now backed by its own
 * PendingProduction collection, kept live-synced going forward by
 * utils/pendingProduction.js (wired into POST /sales/order and
 * POST /sales/order/status in routes/fairdesk_route.js).
 *
 * That live sync only fires on future order create/edit/status-change
 * requests — it can't retroactively create documents for orders that were
 * already PENDING before this feature existed. This script does that one-time
 * catch-up: for every currently-PENDING label/color-label sales order, it
 * upserts the matching PendingProduction document.
 *
 * It also removes any PendingProduction document whose source order is no
 * longer PENDING (or was deleted) — cleaning up drift from any pre-existing
 * test data.
 *
 * Idempotent: safe to re-run any time; upserts are no-ops for docs already
 * correct. Pass --apply to write; defaults to a dry run.
 */

const APPLY = process.argv.includes("--apply");

async function backfillFromOrders(OrderModel, onModel, label) {
  const orders = await OrderModel.find({ status: "PENDING" }).lean();
  console.log(`  ${label}: ${orders.length} PENDING order(s) found.`);

  let created = 0;
  let upToDate = 0;

  for (const order of orders) {
    const existing = await PendingProduction.findById(order._id).lean();
    const itemId = onModel === "ColorLabel" ? order.colorLabelId : order.labelId;
    const matches =
      existing &&
      String(existing.itemId) === String(itemId) &&
      String(existing.userId) === String(order.userId) &&
      Number(existing.quantity) === Number(order.quantity) &&
      Number(existing.dispatchedQuantity || 0) === Number(order.dispatchedQuantity || 0);

    if (matches) {
      upToDate += 1;
      continue;
    }

    created += 1;
    console.log(`  ${existing ? "Would update" : "Would create"} ${label} PendingProduction ${order._id} (item ${itemId}, user ${order.userId})`);
    if (APPLY) {
      await upsertPendingProduction({ ...order, onModel });
    }
  }

  return { total: orders.length, created, upToDate };
}

async function cleanupOrphans() {
  const docs = await PendingProduction.find({}).select("_id onModel").lean();
  let removed = 0;

  for (const doc of docs) {
    const OrderModel = doc.onModel === "ColorLabel" ? ColorLabelSalesOrder : LabelSalesOrder;
    const order = await OrderModel.findById(doc._id).select("status").lean();
    if (order && order.status === "PENDING") continue;

    removed += 1;
    console.log(`  ${APPLY ? "Removing" : "Would remove"} orphaned PendingProduction ${doc._id} (source order ${order ? `now ${order.status}` : "no longer exists"})`);
    if (APPLY) {
      await PendingProduction.deleteOne({ _id: doc._id });
    }
  }

  return { checked: docs.length, removed };
}

async function run() {
  try {
    let uri = process.env.MONGO_URI || "mongodb://localhost:27017/fairdesk";
    const user = process.env.MONGO_USER;
    const pass = process.env.MONGO_PASS;
    if (user && pass && uri.startsWith("mongodb://") && !uri.includes("@")) {
      uri = uri.replace("mongodb://", `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`);
      if (!uri.includes("authSource")) uri += (uri.includes("?") ? "&" : "?") + "authSource=admin";
    }
    await mongoose.connect(uri);
    console.log(`Database connected.${APPLY ? "" : "  (DRY RUN — pass --apply to write changes)"}\n`);

    console.log("Backfilling from PENDING orders:");
    const labelResult = await backfillFromOrders(LabelSalesOrder, "Label", "Label");
    const colorResult = await backfillFromOrders(ColorLabelSalesOrder, "ColorLabel", "ColorLabel");

    console.log("\nCleaning up orphaned PendingProduction docs (source order no longer PENDING):");
    const cleanup = await cleanupOrphans();
    if (!cleanup.removed) console.log("  none found.");

    console.log("\n================ Summary ================");
    console.log(`Label: ${labelResult.total} PENDING orders, ${APPLY ? "created/updated" : "would create/update"} ${labelResult.created}, already correct ${labelResult.upToDate}`);
    console.log(`ColorLabel: ${colorResult.total} PENDING orders, ${APPLY ? "created/updated" : "would create/update"} ${colorResult.created}, already correct ${colorResult.upToDate}`);
    console.log(`Orphans: checked ${cleanup.checked}, ${APPLY ? "removed" : "would remove"} ${cleanup.removed}`);
    console.log("==========================================");
    console.log(APPLY ? "Done — changes written." : "Dry run complete — re-run with --apply to write these changes.");

    process.exit(0);
  } catch (err) {
    console.error("Backfill script failed:", err);
    process.exit(1);
  }
}

run();
