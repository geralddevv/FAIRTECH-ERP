import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import Username from "../../models/users/username.js";
import TapeBinding from "../../models/inventory/tapeBinding.js";
import TtrBinding from "../../models/inventory/ttrBinding.js";
import PosRollBinding from "../../models/inventory/posRollBinding.js";
import TafetaBinding from "../../models/inventory/tafetaBinding.js";
import Label from "../../models/inventory/labels.js";
import ColorLabel from "../../models/inventory/colorLabel.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Migration: make item bindings location-specific.
 *
 * Background: bindings are now tied to a user AND a location. The four
 * non-label bindings (tape/ttr/posRoll/tafeta) just gained a required
 * `location` field and a new unique index that includes it. Their existing
 * documents never stored a location (Mongoose strict mode dropped the value
 * the form sent), so we must backfill it before the new unique index can be
 * built. Label/colorLabel bindings already required `location`; we only
 * backfill any that happen to be missing it.
 *
 * Steps:
 *   1. Backfill `location` on tape/ttr/posRoll/tafeta bindings that lack it,
 *      using the binding's user primary location
 *      (locationDetails[0].userLocation || userLocation). Preserves the prior
 *      single-location meaning for existing data.
 *   2. Backfill `location` on label/colorLabel bindings missing it, resolving
 *      the user by clientName + userName.
 *   3. syncIndexes() on the four non-label models to DROP the stale
 *      (location-less) unique index and BUILD the new one including location.
 *
 * Idempotent: documents that already carry a location are left untouched, so
 * re-running makes no further changes. Pass --dry-run to preview only.
 */

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = 500;

const s = (v) => String(v ?? "").trim();

// Match the form's location normalization (see getUserLocationEntries in the
// binding views): uppercase, collapse whitespace, strip edge dots/commas.
function normalizeLocationName(value) {
  return s(value)
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/^[.,]+|[.,]+$/g, "");
}

// Primary (first) location of a user, falling back to the top-level mirror.
function primaryLocationOf(user) {
  const details = Array.isArray(user?.locationDetails) ? user.locationDetails : [];
  for (const entry of details) {
    const loc = normalizeLocationName(entry?.userLocation || entry?.location);
    if (loc) return loc;
  }
  return normalizeLocationName(user?.userLocation);
}

const missingLocationFilter = {
  $or: [{ location: { $exists: false } }, { location: null }, { location: "" }],
};

// Backfill the four non-label models (linked to a user via userId).
async function backfillByUserId(Model, label) {
  const docs = await Model.find(missingLocationFilter)
    .select("_id userId location")
    .lean();

  if (!docs.length) {
    console.log(`  ${label}: nothing to backfill (all have a location).`);
    return { updated: 0, skipped: 0 };
  }

  // Resolve every referenced user's primary location once.
  const userIds = [...new Set(docs.map((d) => String(d.userId)).filter(Boolean))];
  const users = await Username.find({ _id: { $in: userIds } })
    .select("_id userLocation locationDetails")
    .lean();
  const locByUser = new Map(users.map((u) => [String(u._id), primaryLocationOf(u)]));

  let updated = 0;
  let skipped = 0;
  let ops = [];
  let sampleShown = false;

  for (const doc of docs) {
    const location = locByUser.get(String(doc.userId));
    if (!location) {
      skipped += 1;
      console.warn(`  ! ${label}: no resolvable location for binding ${doc._id} (userId ${doc.userId}).`);
      continue;
    }

    if (!sampleShown) {
      sampleShown = true;
      console.log(`  ${label} sample: binding ${doc._id} -> location "${location}"`);
    }

    updated += 1;
    if (!DRY_RUN) {
      ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { location } } } });
      if (ops.length >= BATCH_SIZE) {
        await Model.collection.bulkWrite(ops, { ordered: false });
        ops = [];
      }
    }
  }

  if (!DRY_RUN && ops.length) {
    await Model.collection.bulkWrite(ops, { ordered: false });
  }

  console.log(`  ${label}: ${DRY_RUN ? "would update" : "updated"} ${updated}, skipped ${skipped}.`);
  return { updated, skipped };
}

// Backfill label/colorLabel models (denormalized: clientName + userName, no userId).
async function backfillByClientUser(Model, label) {
  const docs = await Model.find(missingLocationFilter)
    .select("_id clientName userName location")
    .lean();

  if (!docs.length) {
    console.log(`  ${label}: nothing to backfill (all have a location).`);
    return { updated: 0, skipped: 0 };
  }

  const cache = new Map(); // "clientName|userName" (lowercase) -> primary location
  const keyOf = (clientName, userName) =>
    `${s(clientName).toLowerCase()}|${s(userName).toLowerCase()}`;

  async function resolveLocation(clientName, userName) {
    const key = keyOf(clientName, userName);
    if (cache.has(key)) return cache.get(key);
    const user = await Username.findOne({
      clientName: new RegExp(`^${s(clientName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
      userName: new RegExp(`^${s(userName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i"),
    })
      .select("userLocation locationDetails")
      .lean();
    const loc = user ? primaryLocationOf(user) : "";
    cache.set(key, loc);
    return loc;
  }

  let updated = 0;
  let skipped = 0;
  let ops = [];

  for (const doc of docs) {
    const location = await resolveLocation(doc.clientName, doc.userName);
    if (!location) {
      skipped += 1;
      console.warn(`  ! ${label}: no resolvable location for binding ${doc._id} (${doc.clientName} / ${doc.userName}).`);
      continue;
    }
    updated += 1;
    if (!DRY_RUN) {
      ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: { location } } } });
      if (ops.length >= BATCH_SIZE) {
        await Model.collection.bulkWrite(ops, { ordered: false });
        ops = [];
      }
    }
  }

  if (!DRY_RUN && ops.length) {
    await Model.collection.bulkWrite(ops, { ordered: false });
  }

  console.log(`  ${label}: ${DRY_RUN ? "would update" : "updated"} ${updated}, skipped ${skipped}.`);
  return { updated, skipped };
}

// Drop the stale unique index and build the new one (incl. location).
async function syncModelIndexes(Model, label) {
  if (DRY_RUN) {
    console.log(`  ${label}: (dry run) would syncIndexes().`);
    return;
  }
  try {
    await Model.syncIndexes();
    console.log(`  ${label}: indexes synced.`);
  } catch (err) {
    console.error(`  ! ${label}: syncIndexes failed — ${err.message}`);
    console.error("    Resolve duplicate (userId + specs + location) bindings, then re-run.");
  }
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
    console.log(`Database connected.${DRY_RUN ? "  (DRY RUN — no writes)" : ""}\n`);

    console.log("Step 1/3 — Backfill location on tape/ttr/posRoll/tafeta bindings:");
    await backfillByUserId(TapeBinding, "Tape");
    await backfillByUserId(TtrBinding, "TTR");
    await backfillByUserId(PosRollBinding, "PosRoll");
    await backfillByUserId(TafetaBinding, "Tafeta");

    console.log("\nStep 2/3 — Backfill location on label/colorLabel bindings (if any missing):");
    await backfillByClientUser(Label, "Label");
    await backfillByClientUser(ColorLabel, "ColorLabel");

    console.log("\nStep 3/3 — Sync indexes on the four non-label models (drop stale unique index):");
    await syncModelIndexes(TapeBinding, "Tape");
    await syncModelIndexes(TtrBinding, "TTR");
    await syncModelIndexes(PosRollBinding, "PosRoll");
    await syncModelIndexes(TafetaBinding, "Tafeta");

    console.log("\n================ Done ================");
    console.log(DRY_RUN ? "Dry run complete — no changes written." : "Migration complete.");
    console.log("=====================================");

    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  }
}

run();
