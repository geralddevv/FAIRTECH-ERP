import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import Label from "../../models/inventory/labels.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Two-phase migration for labelsBinding (Label model):
 *
 * Phase 1 -- Backfill `billingType` from the existing `moqUnit` field, which
 * the two share an enum with (ROLLS / LABELS). billingType was added after
 * moqUnit already had live data, so existing bindings need billingType set
 * to match their current moqUnit rather than falling back to the schema
 * default. This also preserves the original unit on the record before
 * moqUnit itself goes away in Phase 2.
 *
 * Phase 2 -- Retire `moqUnit`. Orders are always placed in labels now (see
 * GET /sales/items/:type/:userId in routes/fairdesk_route.js), which already
 * converts a ROLLS-tagged binding's minOrderQty to its label equivalent on
 * the fly at read time. This phase makes that conversion PERMANENT --
 * multiplies minOrderQty by perRollQty for every still-ROLLS binding -- and
 * then unsets the moqUnit field, since nothing needs to interpret it anymore.
 * Skips any binding that hasn't gone through Phase 1 yet (billingType is the
 * only remaining record of what moqUnit used to be).
 *
 * Idempotent: safe to re-run. Pass --apply to write; defaults to a dry run.
 */

const APPLY = process.argv.includes("--apply");

async function phase1BackfillBillingType() {
  const bindings = await Label.find({})
    .select("productId clientName userName location moqUnit billingType")
    .lean();

  let updated = 0;
  let alreadyCorrect = 0;

  for (const b of bindings) {
    const target = b.moqUnit === "ROLLS" ? "ROLLS" : "LABELS";

    if (b.billingType === target) {
      alreadyCorrect++;
      continue;
    }

    console.log(
      `[Phase 1] ${b.productId} (${b.clientName || "?"} / ${b.userName || "?"} @ ${b.location || "?"}): ` +
        `billingType "${b.billingType || "(none)"}" -> "${target}" (moqUnit: ${b.moqUnit || "(none)"})`,
    );

    if (APPLY) {
      await Label.updateOne({ _id: b._id }, { $set: { billingType: target } });
    }
    updated++;
  }

  return { total: bindings.length, updated, alreadyCorrect };
}

async function phase2RetireMoqUnit() {
  const bindings = await Label.find({ moqUnit: { $exists: true } })
    .select("productId clientName userName location moqUnit minOrderQty perRollQty billingType")
    .lean();

  let converted = 0;
  let unset = 0;
  let skipped = 0;

  for (const b of bindings) {
    if (!b.billingType) {
      console.log(`[Phase 2] SKIP ${b.productId}: no billingType recorded yet -- run Phase 1 first.`);
      skipped++;
      continue;
    }

    const update = { $unset: { moqUnit: "" } };

    if (b.moqUnit === "ROLLS") {
      const perRollQty = Number(b.perRollQty) || 0;
      const convertedQty = ((Number(b.minOrderQty) || 0) * perRollQty) || Number(b.minOrderQty) || 0;
      console.log(
        `[Phase 2] ${b.productId} (${b.clientName || "?"} / ${b.userName || "?"} @ ${b.location || "?"}): ` +
          `minOrderQty ${b.minOrderQty} rolls -> ${convertedQty} labels, moqUnit removed`,
      );
      update.$set = { minOrderQty: String(convertedQty) };
      converted++;
    } else {
      console.log(`[Phase 2] ${b.productId}: moqUnit removed (was already LABELS)`);
    }

    if (APPLY) {
      await Label.updateOne({ _id: b._id }, update);
    }
    unset++;
  }

  return { total: bindings.length, converted, unset, skipped };
}

async function run() {
  let uri = process.env.MONGO_URI || "mongodb://localhost:27017/fairdesk";
  const user = process.env.MONGO_USER;
  const pass = process.env.MONGO_PASS;
  if (user && pass && uri.startsWith("mongodb://") && !uri.includes("@")) {
    uri = uri.replace("mongodb://", `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`);
    if (!uri.includes("authSource")) uri += (uri.includes("?") ? "&" : "?") + "authSource=admin";
  }
  await mongoose.connect(uri);
  console.log(`Database connected.${APPLY ? "" : "  (DRY RUN — pass --apply to write changes)"}\n`);

  const phase1 = await phase1BackfillBillingType();
  console.log("\n--- Phase 1 Summary (billingType backfill) ---");
  console.log(`Total bindings: ${phase1.total}, updated ${phase1.updated}, already correct ${phase1.alreadyCorrect}`);

  const phase2 = await phase2RetireMoqUnit();
  console.log("\n--- Phase 2 Summary (retire moqUnit) ---");
  console.log(
    `Bindings with moqUnit: ${phase2.total}, converted (ROLLS -> labels) ${phase2.converted}, ` +
      `unset ${phase2.unset}, skipped (no billingType yet) ${phase2.skipped}`,
  );

  if (!APPLY && phase1.updated + phase2.unset > 0) {
    console.log("\nRe-run with --apply to write these changes.");
  }
  if (phase2.skipped > 0) {
    console.log("\nSome bindings were skipped in Phase 2 -- re-run this script (it runs Phase 1 first) until skipped is 0.");
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
