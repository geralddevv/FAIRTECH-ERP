import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import Label from "../../models/inventory/labels.js";
import ColorLabel from "../../models/inventory/colorLabel.js";
import Username from "../../models/users/username.js";
import { escapeRegex } from "../../utils/security.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Label/ColorLabel bindings created before the userId reference existed
 * (see models/inventory/labels.js, colorLabel.js) only carry a denormalized
 * snapshot of clientName/userName/userContact/location, captured at binding
 * creation time. Anything that needs current values should populate userId
 * instead — see utils/reconcileBindingLocations.js (syncLabelBindingIdentity,
 * reconcileUserBindingLocations), which keep both the live reference AND the
 * legacy snapshot fields in sync going forward whenever a user is edited.
 *
 * This script does the one-time catch-up: backfills userId on bindings that
 * predate it, by matching clientName/userName against the live Username
 * collection (narrowed by location when a name is ambiguous at that client).
 * Matches are also used to refresh the snapshot fields in case they'd
 * already drifted.
 *
 * Entries where the match is missing or ambiguous are left untouched and
 * reported for manual review — guessing wrong here would silently attach a
 * binding to the wrong client's user.
 *
 * Idempotent: safe to re-run — bindings that already have userId are skipped.
 * Pass --apply to write; defaults to a dry run.
 */

const APPLY = process.argv.includes("--apply");

function norm(v) {
  return String(v ?? "").trim();
}

async function findLiveUser(binding) {
  const clientName = norm(binding.clientName);
  const userName = norm(binding.userName);
  if (!clientName || !userName) return { match: null, reason: "missing clientName/userName on the binding" };

  const candidates = await Username.find({
    clientName: new RegExp(`^${escapeRegex(clientName)}$`, "i"),
    userName: new RegExp(`^${escapeRegex(userName)}$`, "i"),
  }).lean();

  if (!candidates.length) return { match: null, reason: "no matching user found" };
  if (candidates.length === 1) return { match: candidates[0], reason: null };

  // Multiple users with the same name at the same client — narrow by location.
  const bindingLoc = norm(binding.location).toUpperCase();
  const byLocation = candidates.filter((u) => {
    if (norm(u.userLocation).toUpperCase() === bindingLoc) return true;
    return (u.locationDetails || []).some((ld) => norm(ld.userLocation).toUpperCase() === bindingLoc);
  });

  if (byLocation.length === 1) return { match: byLocation[0], reason: null };
  return { match: null, reason: `ambiguous — ${candidates.length} users named "${userName}" at "${clientName}"` };
}

async function backfillModel(Model, label) {
  const bindings = await Model.find({ userId: { $exists: false } }).lean();
  console.log(`${label}: ${bindings.length} binding(s) without a live userId.`);

  let fixed = 0;
  let unmatched = 0;

  for (const binding of bindings) {
    const { match, reason } = await findLiveUser(binding);

    if (!match) {
      unmatched += 1;
      console.log(`  SKIP ${binding._id} (${binding.clientName || ""} / ${binding.userName || ""}): ${reason}`);
      continue;
    }

    const changes = [];
    if (norm(binding.userName) !== match.userName) changes.push(`userName "${binding.userName || ""}" -> "${match.userName}"`);
    if (norm(binding.userContact) !== match.userContact) changes.push(`userContact "${binding.userContact || ""}" -> "${match.userContact}"`);
    if (norm(binding.clientName) !== match.clientName) changes.push(`clientName "${binding.clientName || ""}" -> "${match.clientName}"`);

    console.log(
      `  ${APPLY ? "Fixing" : "Would fix"} ${binding._id}: linking to user ${match._id} (${match.clientName} / ${match.userName})` +
        (changes.length ? ` — ${changes.join(", ")}` : ""),
    );

    fixed += 1;
    if (APPLY) {
      await Model.updateOne(
        { _id: binding._id },
        {
          $set: {
            userId: match._id,
            userName: match.userName,
            userContact: match.userContact,
            clientName: match.clientName,
          },
        },
      );
    }
  }

  return { total: bindings.length, fixed, unmatched };
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

    const labelResult = await backfillModel(Label, "Label");
    console.log("");
    const colorLabelResult = await backfillModel(ColorLabel, "ColorLabel");

    console.log("\n================ Summary ================");
    console.log(`Label: ${labelResult.total} missing userId, ${APPLY ? "fixed" : "would fix"} ${labelResult.fixed}, unmatched ${labelResult.unmatched}`);
    console.log(`ColorLabel: ${colorLabelResult.total} missing userId, ${APPLY ? "fixed" : "would fix"} ${colorLabelResult.fixed}, unmatched ${colorLabelResult.unmatched}`);
    console.log("==========================================");
    console.log(APPLY ? "Done — changes written." : "Dry run complete — re-run with --apply to write these changes.");

    process.exit(0);
  } catch (err) {
    console.error("Backfill script failed:", err);
    process.exit(1);
  }
}

run();
