import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import SalesOrderLog from "../models/inventory/SalesOrderLog.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Cleanup: remove SalesOrderLog entries for cancelled orders.
 *
 * When a pending order is cancelled, a log with action "CANCELLED" is written
 * and shown on the "Order Action Logs" page (GET /sales/order/logs). This
 * script deletes those cancellation log entries.
 *
 * A CANCELLED log is a history record only — unlike a dispatch (CONFIRMED /
 * DELIVERED) log, it never moved stock, so removing it needs no stock reversal.
 *
 * Idempotent: safe to re-run. Pass --apply to write; defaults to a dry run.
 */

const APPLY = process.argv.includes("--apply");
const CANCELLED_ACTION = "CANCELLED";

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

    const totalLogs = await SalesOrderLog.estimatedDocumentCount();
    const cancelled = await SalesOrderLog.find({ action: CANCELLED_ACTION })
      .select("_id orderId quantity cancelReason performedAt")
      .lean();

    console.log(`Scanned ${totalLogs} sales order log(s).`);

    if (!cancelled.length) {
      console.log("\nNo cancelled logs found — nothing to remove.");
    } else {
      console.log(`\nFound ${cancelled.length} cancelled log(s):`);
      cancelled.forEach((l) => {
        const when = l.performedAt ? new Date(l.performedAt).toISOString() : "unknown date";
        const reason = l.cancelReason ? ` — "${l.cancelReason}"` : "";
        console.log(`  ${APPLY ? "Removing" : "Would remove"} log ${l._id} (order ${l.orderId ?? "null"}, ${when})${reason}`);
      });

      if (APPLY) {
        const result = await SalesOrderLog.deleteMany({ action: CANCELLED_ACTION });
        console.log(`\nDeleted ${result.deletedCount} cancelled log(s).`);
      }
    }

    console.log("\n================ Summary ================");
    console.log(`Logs scanned:    ${totalLogs}`);
    console.log(`Cancelled logs:  ${cancelled.length} ${APPLY ? "(removed)" : "(would remove)"}`);
    console.log("==========================================");
    console.log(APPLY ? "Done — changes written." : "Dry run complete — re-run with --apply to write these changes.");

    process.exit(0);
  } catch (err) {
    console.error("Cleanup script failed:", err);
    process.exit(1);
  }
}

run();
