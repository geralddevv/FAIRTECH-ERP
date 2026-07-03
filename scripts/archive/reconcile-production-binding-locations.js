import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import ProductionBinding from "../../models/utilities/productionBinding.js";
import { reconcileProductionBindingLocations } from "../../utils/reconcileBindingLocations.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * One-off repair for Production Binding entries whose userLocation has gone
 * stale (e.g. the user's location was renamed/removed since the binding was
 * created) — the same drift reconcileUserBindingLocations already fixes for
 * Tape/TTR/POS Roll/Tafeta/Label/ColorLabel bindings, now wired in for
 * Production Binding too (see utils/reconcileBindingLocations.js,
 * reconcileProductionBindingLocations, called from POST
 * /form/edit/user/:userId in routes/fairdesk_route.js going forward).
 *
 * This script runs that same reconciliation once across every user who
 * currently has a Production Binding entry, to catch drift that accumulated
 * before that wiring existed. Only re-points a binding when the user now has
 * exactly ONE valid location (unambiguous); anything else is reported for
 * manual review, never guessed at.
 *
 * Idempotent: safe to re-run. Pass --apply to write; defaults to a dry run.
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

    const userIds = await ProductionBinding.distinct("userId", { userId: { $exists: true, $ne: null } });
    console.log(`Found ${userIds.length} distinct user(s) with Production Binding entries.\n`);

    let totalFixed = 0;
    let totalAmbiguous = 0;

    for (const userId of userIds) {
      const { fixed, ambiguous } = await reconcileProductionBindingLocations(userId, { apply: APPLY });
      totalFixed += fixed.length;
      totalAmbiguous += ambiguous.length;
      for (const f of fixed) {
        console.log(`  ${APPLY ? "Fixed" : "Would fix"} ${f.id} (${f.companyName} / ${f.userName}): userLocation "${f.from}" -> "${f.to}"`);
      }
      for (const a of ambiguous) {
        console.log(`  Ambiguous ${a.id} (${a.companyName} / ${a.userName}): "${a.location}" doesn't match any of [${a.validLocs.join(", ")}]`);
      }
    }

    console.log("\n================ Summary ================");
    console.log(`${APPLY ? "Fixed" : "Would fix"}: ${totalFixed}`);
    console.log(`Ambiguous (left untouched): ${totalAmbiguous}`);
    console.log("==========================================");
    console.log(APPLY ? "Done — changes written." : "Dry run complete — re-run with --apply to write these changes.");

    process.exit(0);
  } catch (err) {
    console.error("Reconcile script failed:", err);
    process.exit(1);
  }
}

run();
