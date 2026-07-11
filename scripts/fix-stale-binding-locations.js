import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import Username from "../models/users/username.js";
import Label from "../models/inventory/labels.js";
import ColorLabel from "../models/inventory/colorLabel.js";
import TtrBinding from "../models/inventory/ttrBinding.js";
import TapeBinding from "../models/inventory/tapeBinding.js";
import PosRollBinding from "../models/inventory/posRollBinding.js";
import TafetaBinding from "../models/inventory/tafetaBinding.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Database-wide fix for the class of bug found on RAJESH NATE / G M SYNTEX
 * PVT. LTD.: a client's registered location gets renamed (commonly a town
 * name prepended onto what used to be just a plot code, e.g. "C-3" ->
 * "PALGHAR C-3"), but item bindings created under the old name are never
 * updated to match.
 *
 * reconcileUserBindingLocations() (utils/reconcileBindingLocations.js) runs
 * automatically after every user-location edit, but it only auto-fixes a
 * stale binding when the user has exactly ONE registered location — for
 * multi-location users (the common case for clients with several plants),
 * every mismatch is reported as "ambiguous" and left untouched, silently
 * making that binding disappear from every location-scoped view
 * (/labels/view/:id?location=..., /master/view counts, etc.) even though it
 * still belongs to that user.
 *
 * This script finds every binding across all six binding types whose
 * `location` doesn't match any of its owning user's current locations, then
 * tries to resolve it the same way the GM Syntex fix did: look for exactly
 * one current location that ends with the binding's old value on a word
 * boundary (so "D-23" uniquely matches "BOISAR D-23" but not "D-235"). If
 * exactly one candidate is found, that's an unambiguous rename and gets
 * fixed. Zero or multiple candidates are left for manual review — this
 * script never guesses.
 *
 * Idempotent: safe to re-run. Pass --apply to write; defaults to a dry run.
 */

const APPLY = process.argv.includes("--apply");

const norm = (v) => String(v ?? "").trim().toUpperCase().replace(/\s+/g, " ").replace(/^[.,]+|[.,]+$/g, "");

function userLocations(user) {
  const details = Array.isArray(user.locationDetails) ? user.locationDetails : [];
  const fromDetails = details.map((d) => norm(d.userLocation || d.location)).filter(Boolean);
  if (fromDetails.length) return [...new Set(fromDetails)];
  const fallback = norm(user.userLocation);
  return fallback ? [fallback] : [];
}

// Matches "D-23" -> "BOISAR D-23" but not "D-23" -> "D-235" (word boundary,
// not just a bare substring/suffix check).
function renameCandidates(oldLoc, validLocs) {
  return validLocs.filter(
    (v) => v.endsWith(oldLoc) && (v.length === oldLoc.length || v[v.length - oldLoc.length - 1] === " "),
  );
}

const BINDING_TYPES = [
  [Label, "label", "Label"],
  [ColorLabel, "colorLabel", "ColorLabel"],
  [TtrBinding, "ttr", "TTR"],
  [TapeBinding, "tape", "Tape"],
  [PosRollBinding, "posRoll", "PosRoll"],
  [TafetaBinding, "tafeta", "Tafeta"],
];

async function checkBindingType(Model, field, label) {
  const ops = [];
  let checked = 0;
  let mismatched = 0;
  let fixed = 0;
  let ambiguous = 0;

  const users = await Username.find({ [field]: { $exists: true, $ne: [] } })
    .select(`_id clientName userName userLocation locationDetails ${field}`)
    .populate({ path: field, select: "location productId" })
    .lean();

  for (const user of users) {
    const validLocs = userLocations(user);
    const items = user[field] || [];

    for (const item of items) {
      if (!item) continue;
      checked += 1;
      const itemLoc = norm(item.location);
      if (validLocs.includes(itemLoc)) continue; // matches a real location, fine

      mismatched += 1;
      const candidates = renameCandidates(itemLoc, validLocs);

      if (candidates.length === 1) {
        fixed += 1;
        console.log(
          `  ${label} ${item.productId || item._id} (${user.clientName} / ${user.userName}): ` +
          `"${item.location}" -> "${candidates[0]}"`,
        );
        if (APPLY) {
          ops.push({ updateOne: { filter: { _id: item._id }, update: { $set: { location: candidates[0] } } } });
        }
      } else {
        ambiguous += 1;
        console.warn(
          `  ? ${label} ${item.productId || item._id} (${user.clientName} / ${user.userName}): ` +
          `"${item.location}" matches ${candidates.length} candidate(s) ` +
          `[${candidates.join(", ") || validLocs.join(", ") || "no locations on user"}] — skipped, review manually.`,
        );
      }
    }
  }

  if (APPLY && ops.length) {
    await Model.collection.bulkWrite(ops, { ordered: false });
  }

  return { checked, mismatched, fixed, ambiguous };
}

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

  const results = {};
  for (const [Model, field, label] of BINDING_TYPES) {
    console.log(`${label}:`);
    results[label] = await checkBindingType(Model, field, label);
    if (!results[label].mismatched) console.log("  none found.");
    console.log("");
  }

  console.log("================ Summary ================");
  for (const [, , label] of BINDING_TYPES) {
    const r = results[label];
    console.log(
      `${label}: checked ${r.checked}, mismatched ${r.mismatched} ` +
      `(${APPLY ? "fixed" : "would fix"} ${r.fixed}, ambiguous/skipped ${r.ambiguous})`,
    );
  }
  console.log("==========================================");
  console.log(APPLY ? "Done — changes written." : "Dry run complete — re-run with --apply to write these changes.");

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
