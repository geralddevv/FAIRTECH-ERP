import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import SimCard from "../models/hr/simcard_model.js";
import SimCardLog from "../models/hr/SimCardLog.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Undoes scripts/backfill-simcards-from-office-mobile.js: removes every SIM
 * card that script created, identified by its SimCardLog "ASSIGNED" entry
 * with performedBy === PERFORMED_BY (the same marker the backfill script
 * stamped on every record it made).
 *
 * A SIM card is only removed if that backfill "ASSIGNED" entry is still the
 * *only* log for it — if someone has since edited or removed it via the UI
 * (any other log entry exists for the same SIM card), it's left alone and
 * reported as skipped, since undoing it here would destroy that manual
 * change.
 *
 * Idempotent: safe to re-run. Pass --apply to write; defaults to a dry run.
 */

const APPLY = process.argv.includes("--apply");
const PERFORMED_BY = "SYSTEM (backfill script)";

async function run() {
  let uri = process.env.MONGO_URI || "mongodb://localhost:27017/fairdesk";
  const dbUser = process.env.MONGO_USER;
  const dbPass = process.env.MONGO_PASS;
  if (dbUser && dbPass && uri.startsWith("mongodb://") && !uri.includes("@")) {
    uri = uri.replace("mongodb://", `mongodb://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPass)}@`);
    if (!uri.includes("authSource")) uri += (uri.includes("?") ? "&" : "?") + "authSource=admin";
  }
  await mongoose.connect(uri);
  console.log(`Database connected.${APPLY ? "" : "  (DRY RUN — pass --apply to write changes)"}\n`);

  const backfillLogs = await SimCardLog.find(
    { performedBy: PERFORMED_BY, action: "ASSIGNED" },
    "simCardId employeeName mobileNumber"
  ).lean();

  let removed = 0;
  let skippedModified = 0;
  let skippedMissing = 0;

  for (const log of backfillLogs) {
    const otherLogs = await SimCardLog.countDocuments({
      simCardId: log.simCardId,
      _id: { $ne: log._id },
    });

    if (otherLogs > 0) {
      console.warn(`  ? ${log.employeeName} (${log.mobileNumber}): edited/removed since backfill — skipped.`);
      skippedModified += 1;
      continue;
    }

    const simCard = await SimCard.findById(log.simCardId).lean();
    if (!simCard) {
      skippedMissing += 1;
      continue;
    }

    console.log(`  - ${simCard.employeeName} (${simCard.mobileNumber})`);

    if (APPLY) {
      await SimCard.findByIdAndDelete(log.simCardId);
      await SimCardLog.deleteOne({ _id: log._id });
    }

    removed += 1;
  }

  console.log("\n================ Summary ================");
  console.log(`Backfill-created SIM cards found: ${backfillLogs.length}`);
  console.log(`${APPLY ? "Removed" : "Would remove"}: ${removed}`);
  console.log(`Skipped (edited/removed since backfill): ${skippedModified}`);
  console.log(`Skipped (already gone): ${skippedMissing}`);
  console.log("==========================================");
  console.log(APPLY ? "Done — changes written." : "Dry run complete — re-run with --apply to write these changes.");

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
