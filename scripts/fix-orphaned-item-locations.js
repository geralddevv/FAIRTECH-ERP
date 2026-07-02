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
 * Fix: item bindings (label/colorLabel/ttr/tape/posRoll/tafeta) each carry
 * their own `location` field, which pages like the client details view use
 * to scope items to the location they were clicked from. If a binding's
 * `location` doesn't match ANY of its owning user's registered locations
 * (Username.locationDetails[].userLocation, or the legacy top-level
 * userLocation for single-location users), the binding becomes "orphaned" —
 * it silently disappears from every location-scoped view even though it
 * still belongs to that user.
 *
 * Root cause: the binding forms' Location field is a <select> populated
 * ONLY from the owning user's own locationDetails, so this can't happen
 * going forward. But older records were created before that restriction
 * existed (or before a user's locationDetails were corrected/migrated), and
 * scripts/migrate-binding-location.js only backfilled bindings with a
 * MISSING location — it never validated bindings that already had some
 * (possibly wrong) value, so bad values like a stray note ("NEW GST NO")
 * typed into an old free-text location field were never caught.
 *
 * This script finds every binding whose location doesn't match any of its
 * user's current locations:
 *   - If the user has exactly ONE registered location, the fix is
 *     unambiguous: the binding is auto-corrected to that location.
 *   - If the user has ZERO or MULTIPLE registered locations, the correct
 *     location can't be determined automatically — these are reported for
 *     manual review and left untouched.
 *
 * Defaults to a dry run (report only). Pass --apply to write the
 * unambiguous fixes.
 */

const APPLY = process.argv.includes("--apply");

const s = (v) => String(v ?? "").trim();
const norm = (v) => s(v).toUpperCase().replace(/\s+/g, " ").replace(/^[.,]+|[.,]+$/g, "");

function userLocations(user) {
  const details = Array.isArray(user.locationDetails) ? user.locationDetails : [];
  const fromDetails = details.map((d) => norm(d.userLocation || d.location)).filter(Boolean);
  if (fromDetails.length) return [...new Set(fromDetails)];
  const fallback = norm(user.userLocation);
  return fallback ? [fallback] : [];
}

async function checkBindingType(Model, field, label) {
  const ops = [];
  let checked = 0;
  let orphaned = 0;
  let fixed = 0;
  let ambiguous = 0;
  const ambiguousDetail = [];

  const users = await Username.find({ [field]: { $exists: true, $ne: [] } })
    .select(`_id clientName userName userLocation locationDetails ${field}`)
    .populate({ path: field, select: "location" })
    .lean();

  for (const user of users) {
    const validLocs = userLocations(user);
    const items = user[field] || [];

    for (const item of items) {
      if (!item) continue;
      checked += 1;
      const itemLoc = norm(item.location);
      if (validLocs.includes(itemLoc)) continue; // matches a real location, fine

      orphaned += 1;

      if (validLocs.length === 1) {
        fixed += 1;
        console.log(
          `  ${label} ${item._id} (${user.clientName} / ${user.userName}): "${item.location}" -> "${validLocs[0]}"`,
        );
        if (APPLY) {
          ops.push({ updateOne: { filter: { _id: item._id }, update: { $set: { location: validLocs[0] } } } });
        }
      } else {
        ambiguous += 1;
        ambiguousDetail.push(
          `  ? ${label} ${item._id} (${user.clientName} / ${user.userName}): location "${item.location}" ` +
          `matches none of [${validLocs.join(", ") || "no locations on user"}] — skipped, review manually.`,
        );
      }
    }
  }

  if (ambiguousDetail.length) {
    console.log("");
    ambiguousDetail.forEach((line) => console.warn(line));
  }

  if (APPLY && ops.length) {
    await Model.collection.bulkWrite(ops, { ordered: false });
  }

  return { checked, orphaned, fixed, ambiguous };
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
    console.log(`Database connected.${APPLY ? "" : "  (DRY RUN — pass --apply to write changes)"}\n`);

    const targets = [
      [Label, "label", "Label"],
      [ColorLabel, "colorLabel", "ColorLabel"],
      [TtrBinding, "ttr", "TTR"],
      [TapeBinding, "tape", "Tape"],
      [PosRollBinding, "posRoll", "PosRoll"],
      [TafetaBinding, "tafeta", "Tafeta"],
    ];

    const results = {};
    for (const [Model, field, label] of targets) {
      console.log(`${label}:`);
      results[label] = await checkBindingType(Model, field, label);
      if (!results[label].orphaned) console.log("  none found.");
      console.log("");
    }

    console.log("================ Summary ================");
    for (const [, , label] of targets) {
      const r = results[label];
      console.log(
        `${label}: checked ${r.checked}, orphaned ${r.orphaned} ` +
        `(${APPLY ? "fixed" : "would fix"} ${r.fixed}, ambiguous/skipped ${r.ambiguous})`,
      );
    }
    console.log("==========================================");
    console.log(APPLY ? "Done — changes written." : "Dry run complete — re-run with --apply to write these changes.");

    process.exit(0);
  } catch (err) {
    console.error("Fix script failed:", err);
    process.exit(1);
  }
}

run();
