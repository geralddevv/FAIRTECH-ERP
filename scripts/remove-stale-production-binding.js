import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import ProductionBinding from "../models/utilities/productionBinding.js";
import PendingProduction from "../models/inventory/PendingProduction.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Removes the duplicate ProductionBinding created for KARAN MARKING SYSTEMS
 * PVT LTD / GAYATRI (visible as a stale 15/07/2026 row on /fairtech/prodcalc/view).
 *
 * Root cause: buildProdCalcSignature() hashed a different set of fields
 * depending on which route created the binding (Production Calculator form
 * vs. Assign Production), so the same client+item+die produced two
 * signatures instead of one. Assign Production then created a second,
 * mostly-empty binding (STALE_ID) instead of reusing the original
 * (SURVIVOR_ID), which also carries the real pricing/paper data. That
 * mismatch is now fixed at the source (routes/fairdesk_route.js) -- this
 * script only cleans up the duplicate row it already left behind.
 *
 * Its underlying label (labelProductId) has since been deleted too, so
 * SURVIVOR_ID is left pointing at a since-deleted label same as STALE_ID --
 * this script does not attempt to fix that separate issue.
 *
 * Before deleting, any PendingProduction still pointing at the stale binding
 * is repointed to the survivor so nothing is left referencing a deleted id.
 *
 * Dry-run by default; pass --apply to write.
 */

const APPLY = process.argv.includes("--apply");

const STALE_ID = "6a5778757ed1b41fe67f0b21";
const SURVIVOR_ID = "6a5778497ed1b41fe67f0ae6";

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
  } else {
    console.log(`\nWould repoint ${affected.length} PendingProduction row(s) to ${SURVIVOR_ID} and delete ${STALE_ID}.`);
  }

  console.log("\n==========================================");
  console.log(APPLY ? "Done — changes written." : "Dry run complete — re-run with --apply to write these changes.");

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
