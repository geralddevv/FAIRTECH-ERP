import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import Calculator from "../models/utilities/calculator.js";
import ProductionBinding from "../models/utilities/productionBinding.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * One-time migration: Production Binding used to be saved into the shared
 * `calculators` collection (also used by Rate Calculator and Sales
 * Calculator), distinguished only by the presence of a `dieId` field. It now
 * has its own dedicated `productionbindings` collection (see
 * routes/fairdesk_route.js POST /form/prodcalc and GET /prodcalc/view).
 *
 * This script moves every existing `dieId`-tagged entry out of `calculators`
 * and into `productionbindings`, preserving the original `_id`. Documents are
 * only deleted from `calculators` after a successful insert into
 * `productionbindings`, so a failure partway through never loses data.
 *
 * Idempotent: safe to re-run — entries already present in `productionbindings`
 * (matched by _id) are skipped, and any dieId-tagged leftovers in
 * `calculators` are picked up on a re-run.
 *
 * Pass --apply to write; defaults to a dry run.
 */

const APPLY = process.argv.includes("--apply");

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

    const entries = await Calculator.find({ dieId: { $exists: true, $ne: "" } }).lean();
    console.log(`Found ${entries.length} production binding entr${entries.length === 1 ? "y" : "ies"} in the shared "calculators" collection.\n`);

    let migrated = 0;
    let alreadyMigrated = 0;
    let failed = 0;

    for (const entry of entries) {
      const existing = await ProductionBinding.findById(entry._id).select("_id").lean();
      if (existing) {
        alreadyMigrated += 1;
        console.log(`  Already migrated: ${entry._id} (${entry.companyName || ""})`);
        continue;
      }

      console.log(`  ${APPLY ? "Migrating" : "Would migrate"} ${entry._id} (${entry.companyName || ""} / ${entry.userName || ""})`);
      if (APPLY) {
        try {
          await ProductionBinding.create(entry);
          await Calculator.deleteOne({ _id: entry._id });
          migrated += 1;
        } catch (err) {
          failed += 1;
          console.error(`    FAILED to migrate ${entry._id}:`, err.message);
        }
      } else {
        migrated += 1;
      }
    }

    console.log("\n================ Summary ================");
    console.log(`Total dieId-tagged entries in "calculators": ${entries.length}`);
    console.log(`${APPLY ? "Migrated" : "Would migrate"}: ${migrated}`);
    console.log(`Already migrated (skipped): ${alreadyMigrated}`);
    if (failed) console.log(`Failed: ${failed}`);
    console.log("==========================================");
    console.log(APPLY ? "Done — changes written." : "Dry run complete — re-run with --apply to write these changes.");

    process.exit(0);
  } catch (err) {
    console.error("Migration script failed:", err);
    process.exit(1);
  }
}

run();
