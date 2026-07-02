import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Username from "../../models/users/username.js";
import dotenv from "dotenv";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Migration: restructure the `usernames` collection for per-location dispatch.
 *
 * For every user document:
 *   - Ensure each locationDetails entry carries the dispatch fields
 *     (selfDispatch, transportName, transportContact, dropLocation,
 *      deliveryMode, deliveryLocation, clientPayment).
 *   - Backfill the OLD top-level (global) dispatch into existing location
 *     entries that don't already have their own — preserving prior meaning
 *     (the single dispatch applied across the user's locations).
 *   - If locationDetails is empty/missing, build one entry from the top-level
 *     userLocation/dispatchAddress.
 *   - Apply self-dispatch cleanup (self → blank transport; else blank self).
 *   - Re-sync the top-level mirror fields to locationDetails[0].
 *   - Recompute locationsCount.
 *
 * Idempotent: entries that already carry their own dispatch are left as-is,
 * so re-running makes no further changes. Pass --dry-run to preview only.
 */

const DRY_RUN = process.argv.includes("--dry-run");
const BATCH_SIZE = 500;

const DISPATCH_FIELDS = [
  "selfDispatch",
  "transportName",
  "transportContact",
  "dropLocation",
  "deliveryMode",
  "deliveryLocation",
  "clientPayment",
];

const s = (v) => String(v ?? "").trim();

const ALL_FIELDS = [
  "userLocation",
  "dispatchAddress",
  "selfDispatch",
  ...DISPATCH_FIELDS.filter((f) => f !== "selfDispatch"),
];

// Does this location entry already carry any of its own dispatch details?
function hasDispatch(entry) {
  return DISPATCH_FIELDS.some((f) => s(entry?.[f]) !== "");
}

// Stable JSON (object keys sorted, array order kept) for change detection that
// is sensitive to key PRESENCE — so a stored "" key vs an omitted key differ.
function stable(v) {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object") {
    return "{" + Object.keys(v).sort().map((k) => JSON.stringify(k) + ":" + stable(v[k])).join(",") + "}";
  }
  return JSON.stringify(v);
}

// Represent a stored entry exactly as persisted (keeps "" keys, raw values) so
// we can detect both stale empty keys and untrimmed values.
function storedEntryRepr(entry) {
  const o = {};
  for (const k of ALL_FIELDS) if (entry?.[k] !== undefined) o[k] = String(entry[k]);
  return o;
}

// The old top-level (global) dispatch block.
function topLevelDispatch(doc) {
  return {
    selfDispatch: s(doc.SelfDispatch),
    transportName: s(doc.transportName),
    transportContact: s(doc.transportContact),
    dropLocation: s(doc.dropLocation),
    deliveryMode: s(doc.deliveryMode),
    deliveryLocation: s(doc.deliveryLocation),
    clientPayment: s(doc.clientPayment),
  };
}

// Normalize one entry: keep only fields that carry a value. A self-dispatch
// entry keeps just selfDispatch; transport fields are omitted (and so are any
// empty transport fields on a transport entry).
function cleanEntry(entry) {
  const out = {
    userLocation: s(entry.userLocation || entry.location),
    dispatchAddress: s(entry.dispatchAddress || entry.address),
  };
  if (s(entry.selfDispatch)) {
    out.selfDispatch = "Self Dispatch";
  } else {
    const set = (k, v) => { if (v) out[k] = v; };
    set("transportName", s(entry.transportName));
    set("transportContact", s(entry.transportContact));
    set("dropLocation", s(entry.dropLocation));
    set("deliveryMode", s(entry.deliveryMode));
    set("deliveryLocation", s(entry.deliveryLocation));
    set("clientPayment", s(entry.clientPayment));
  }
  return out;
}

// Build the conformant locationDetails array for a document (or [] if no data).
function buildLocationDetails(doc) {
  const top = topLevelDispatch(doc);
  let entries = Array.isArray(doc.locationDetails) ? doc.locationDetails : [];

  if (!entries.length) {
    const userLocation = s(doc.userLocation);
    const dispatchAddress = s(doc.dispatchAddress);
    if (!userLocation && !dispatchAddress) return [];
    entries = [{ userLocation, dispatchAddress }];
  }

  return entries.map((entry) =>
    cleanEntry(hasDispatch(entry) ? entry : { ...entry, ...top }),
  );
}

// Top-level fields this migration manages (mirror of the primary location).
const TOP_FIELDS = [
  "userLocation",
  "dispatchAddress",
  "SelfDispatch",
  "transportName",
  "transportContact",
  "dropLocation",
  "deliveryMode",
  "deliveryLocation",
  "clientPayment",
];

function buildSet(locationDetails) {
  const primary = locationDetails[0];
  return {
    locationDetails,
    locationsCount: locationDetails.length,
    // Top-level mirror = primary (first) location ("" clears stale values).
    userLocation: primary.userLocation,
    dispatchAddress: primary.dispatchAddress,
    SelfDispatch: primary.selfDispatch || "",
    transportName: primary.transportName || "",
    transportContact: primary.transportContact || "",
    dropLocation: primary.dropLocation || "",
    deliveryMode: primary.deliveryMode || "",
    deliveryLocation: primary.deliveryLocation || "",
    clientPayment: primary.clientPayment || "",
  };
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

    let scanned = 0;
    let changed = 0;
    let skippedNoData = 0;
    let unchanged = 0;
    let sampleShown = false;
    let ops = [];

    const cursor = Username.find({}).lean().cursor();

    for (let doc = await cursor.next(); doc != null; doc = await cursor.next()) {
      scanned += 1;

      const locationDetails = buildLocationDetails(doc);
      if (!locationDetails.length) {
        skippedNoData += 1;
        console.warn(`  ! Skipped (no location data): ${doc._id} ${doc.userName || ""}`);
        continue;
      }

      const set = buildSet(locationDetails);

      // Change detection: locationDetails compared on key presence (so stored
      // "" keys that should be dropped count as a change); top-level + count by value.
      const ldChanged = stable((doc.locationDetails || []).map(storedEntryRepr)) !== stable(set.locationDetails);
      const topChanged =
        TOP_FIELDS.some((k) => String(doc[k] ?? "") !== String(set[k] ?? "")) ||
        Number(doc.locationsCount ?? 0) !== set.locationsCount;

      if (!ldChanged && !topChanged) {
        unchanged += 1;
        continue;
      }

      changed += 1;

      if (!sampleShown) {
        sampleShown = true;
        console.log("Sample change:");
        console.log(`  _id: ${doc._id}  user: ${doc.userName || ""} (${doc.clientName || ""})`);
        console.log("  BEFORE locationDetails:", JSON.stringify(doc.locationDetails || [], null, 2));
        console.log("  AFTER  locationDetails:", JSON.stringify(set.locationDetails, null, 2));
        console.log("");
      }

      if (!DRY_RUN) {
        ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: set } } });
        if (ops.length >= BATCH_SIZE) {
          await Username.collection.bulkWrite(ops, { ordered: false });
          ops = [];
        }
      }
    }

    if (!DRY_RUN && ops.length) {
      await Username.collection.bulkWrite(ops, { ordered: false });
    }

    console.log("================ Summary ================");
    console.log(`Scanned:          ${scanned}`);
    console.log(`${DRY_RUN ? "Would update:   " : "Updated:        "}  ${changed}`);
    console.log(`Already conformant: ${unchanged}`);
    console.log(`Skipped (no data):  ${skippedNoData}`);
    console.log("========================================");

    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  }
}

run();
