import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import VendorUser from "../models/users/vendorUser.js";
import VendorTapeBinding from "../models/inventory/vendorTapeBinding.js";
import VendorPosRollBinding from "../models/inventory/vendorPosRollBinding.js";
import VendorTafetaBinding from "../models/inventory/vendorTafetaBinding.js";
import VendorTtrBinding from "../models/inventory/vendorTtrBinding.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Migration: make vendor item bindings location-specific.
 *
 * Background: a vendor coordinator (VendorUser) can have multiple locations
 * (locationDetails[]), but vendor item bindings (tape/posRoll/tafeta/ttr)
 * were only ever tied to the coordinator, not to a specific one of their
 * locations — so the app couldn't represent "this vendor has item X at
 * location A but not location B". The four vendor binding models just
 * gained a required `location` field and a new unique index that includes
 * it (mirroring scripts/archive/migrate-binding-location.js, which did the
 * same thing for the client-side bindings). Existing documents never stored
 * a location, so it must be backfilled before the new unique index can be
 * built.
 *
 * Steps:
 *   1. Backfill `location` on bindings that lack it, using the binding's
 *      vendor user's primary location (locationDetails[0].userLocation ||
 *      userLocation). Coordinators with more than one location get their
 *      first one as a reasonable default — correct via the binding's edit
 *      form afterward if it's actually the other location.
 *   2. syncIndexes() on the four models to DROP the stale (location-less)
 *      unique index and BUILD the new one including location.
 *
 * Idempotent: documents that already carry a location are left untouched, so
 * re-running makes no further changes. Dry-run by default; pass --apply to
 * write.
 */

const APPLY = process.argv.includes("--apply");
const BATCH_SIZE = 500;

const s = (v) => String(v ?? "").trim();

// Matches the client-side normalizeLocationName used in the binding forms.
function normalizeLocationName(value) {
  return s(value)
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/^[.,]+|[.,]+$/g, "");
}

// Primary (first) location of a vendor user, falling back to the top-level mirror.
function primaryLocationOf(vendorUser) {
  const details = Array.isArray(vendorUser?.locationDetails) ? vendorUser.locationDetails : [];
  for (const entry of details) {
    const loc = normalizeLocationName(entry?.userLocation || entry?.location);
    if (loc) return loc;
  }
  return normalizeLocationName(vendorUser?.userLocation);
}

const missingLocationFilter = {
  $or: [{ location: { $exists: false } }, { location: null }, { location: "" }],
};

async function backfillModel(Model, label) {
  const docs = await Model.find(missingLocationFilter).select("_id vendorUserId location").lean();

  if (!docs.length) {
    console.log(`  ${label}: nothing to backfill (all have a location).`);
    return { updated: 0, skipped: 0 };
  }

  const vendorUserIds = [...new Set(docs.map((d) => String(d.vendorUserId)).filter(Boolean))];
  const vendorUsers = await VendorUser.find({ _id: { $in: vendorUserIds } })
    .select("_id userLocation locationDetails")
    .lean();
  const locByVendorUser = new Map(vendorUsers.map((u) => [String(u._id), primaryLocationOf(u)]));

  let updated = 0;
  let skipped = 0;
  let ops = [];
  let sampleShown = false;
  const multiLocationFlags = [];

  for (const doc of docs) {
    const vendorUser = vendorUsers.find((u) => String(u._id) === String(doc.vendorUserId));
    const location = locByVendorUser.get(String(doc.vendorUserId));
    if (!location) {
      skipped += 1;
      console.warn(`  ! ${label}: no resolvable location for binding ${doc._id} (vendorUserId ${doc.vendorUserId}).`);
      continue;
    }

    if ((vendorUser?.locationDetails || []).length > 1) {
      multiLocationFlags.push(`${doc._id} -> "${location}" (coordinator has ${vendorUser.locationDetails.length} locations, review manually)`);
    }

    if (!sampleShown) {
      sampleShown = true;
      console.log(`  ${label} sample: binding ${doc._id} -> location "${location}"`);
    }

    updated += 1;
    if (APPLY) {
      ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { location } } } });
      if (ops.length >= BATCH_SIZE) {
        await Model.collection.bulkWrite(ops, { ordered: false });
        ops = [];
      }
    }
  }

  if (APPLY && ops.length) {
    await Model.collection.bulkWrite(ops, { ordered: false });
  }

  if (multiLocationFlags.length) {
    console.log(`  ${label}: ${multiLocationFlags.length} binding(s) belong to a multi-location coordinator — defaulted to primary location, review if wrong:`);
    multiLocationFlags.forEach((line) => console.log(`    ? ${line}`));
  }

  console.log(`  ${label}: ${APPLY ? "updated" : "would update"} ${updated}, skipped ${skipped}.`);
  return { updated, skipped };
}

async function syncModelIndexes(Model, label) {
  if (!APPLY) {
    console.log(`  ${label}: (dry run) would syncIndexes().`);
    return;
  }
  try {
    await Model.syncIndexes();
    console.log(`  ${label}: indexes synced.`);
  } catch (err) {
    console.error(`  ! ${label}: syncIndexes failed — ${err.message}`);
    console.error("    Resolve duplicate (vendorUserId + specs + location) bindings, then re-run.");
  }
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

  console.log("Step 1/2 — Backfill location on vendor tape/posRoll/tafeta/ttr bindings:");
  await backfillModel(VendorTapeBinding, "VendorTape");
  await backfillModel(VendorPosRollBinding, "VendorPosRoll");
  await backfillModel(VendorTafetaBinding, "VendorTafeta");
  await backfillModel(VendorTtrBinding, "VendorTtr");

  console.log("\nStep 2/2 — Sync indexes (drop stale unique index, build the one including location):");
  await syncModelIndexes(VendorTapeBinding, "VendorTape");
  await syncModelIndexes(VendorPosRollBinding, "VendorPosRoll");
  await syncModelIndexes(VendorTafetaBinding, "VendorTafeta");
  await syncModelIndexes(VendorTtrBinding, "VendorTtr");

  console.log("\n================ Done ================");
  console.log(APPLY ? "Migration complete." : "Dry run complete — re-run with --apply to write these changes.");
  console.log("=======================================");

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
