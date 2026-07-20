import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "crypto";
import dotenv from "dotenv";

import ProductionBinding from "../models/utilities/productionBinding.js";
import PendingProduction from "../models/inventory/PendingProduction.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Same root cause / same shape as scripts/remove-stale-production-binding.js
 * (which fixed this for KARAN MARKING SYSTEMS PVT LTD): two ProductionBinding
 * docs exist for NAYASA SUPERPLAST / JASWANT KANOJIYA, same client+label+die.
 *
 *   SURVIVOR_ID (6a44f5b13be370fc7dfee63f) -- created 2026-07-01 via the
 *     Production Calculator form, has the real vendor/rate/margin data, but
 *     predates the prodSignature system so had none.
 *   STALE_ID (6a5dbf576ab65ffbfde54b2f) -- created 2026-07-20 by Assign
 *     Production, which couldn't find the signature-less survivor and
 *     created this sparse duplicate instead of updating it.
 *
 * The route bug that caused this is already fixed at the source
 * (routes/fairdesk_route.js, POST /labels/production/assign/:id now falls
 * back to matching by userId+labelProductId+dieId when no signature match is
 * found). This script only cleans up the duplicate it already left behind:
 * repoints any PendingProduction still pointing at the stale binding to the
 * survivor, backfills the survivor's prodSignature, then deletes the stale row.
 *
 * Dry-run by default; pass --apply to write.
 */

const APPLY = process.argv.includes("--apply");

const SURVIVOR_ID = "6a44f5b13be370fc7dfee63f";
const STALE_ID = "6a5dbf576ab65ffbfde54b2f";

function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}
function normalizeProdCalcPart(value) {
  return String(value ?? "").trim().toUpperCase();
}
function buildProdCalcSignature(source) {
  return [
    normalizeProdCalcPart(source.companyName),
    normalizeProdCalcPart(source.userId),
    normalizeProdCalcPart(source.userLocation),
    normalizeProdCalcPart(source.labelProductId),
    normalizeProdCalcPart(source.dieId),
    normalizeProdCalcPart(source.blockId),
  ].join("||");
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

  const stale = await ProductionBinding.findById(STALE_ID).lean();
  if (!stale) {
    console.log(`Stale binding ${STALE_ID} not found — nothing to do (already removed?).`);
    await mongoose.disconnect();
    return;
  }

  const survivor = await ProductionBinding.findById(SURVIVOR_ID).lean();
  if (!survivor) {
    console.log(`! Survivor binding ${SURVIVOR_ID} not found. Refusing to delete ${STALE_ID} — investigate manually.`);
    await mongoose.disconnect();
    process.exit(1);
  }

  console.log(`Stale:    ${stale._id}  (companyName=${stale.companyName || "—"}, created ${stale._id.getTimestamp().toISOString()})`);
  console.log(`Survivor: ${survivor._id}  (companyName=${survivor.companyName || "—"}, created ${survivor._id.getTimestamp().toISOString()})`);

  const affected = await PendingProduction.find({ productionBindingId: STALE_ID }).lean();
  console.log(`\nPendingProduction rows pointing at the stale binding: ${affected.length}`);
  affected.forEach((p) => console.log(`  ${p._id}  poNumber=${p.poNumber || "—"}`));

  const prodSignature = hashSignature(buildProdCalcSignature(survivor));
  const needsSignatureBackfill = survivor.prodSignature !== prodSignature;
  console.log(`\nSurvivor prodSignature ${needsSignatureBackfill ? "needs backfill" : "already correct"}: ${prodSignature}`);

  if (APPLY) {
    if (affected.length) {
      const res = await PendingProduction.updateMany(
        { productionBindingId: STALE_ID },
        { $set: { productionBindingId: SURVIVOR_ID } },
      );
      console.log(`\nRepointed ${res.modifiedCount} PendingProduction row(s) to the survivor binding.`);
    }
    await ProductionBinding.findByIdAndDelete(STALE_ID);
    console.log(`Deleted stale ProductionBinding ${STALE_ID}.`);
    if (needsSignatureBackfill) {
      await ProductionBinding.updateOne({ _id: SURVIVOR_ID }, { $set: { prodSignature } });
      console.log(`Backfilled prodSignature on survivor ${SURVIVOR_ID}.`);
    }
  } else {
    console.log(`\nWould repoint ${affected.length} PendingProduction row(s) to ${SURVIVOR_ID}, delete ${STALE_ID}, and ${needsSignatureBackfill ? "backfill the survivor's prodSignature" : "leave the survivor's prodSignature as-is"}.`);
  }

  console.log("\n==========================================");
  console.log(APPLY ? "Done — changes written." : "Dry run complete — re-run with --apply to write these changes.");

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
