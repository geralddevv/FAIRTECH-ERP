import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import Username from "../../models/users/username.js";
import Label from "../../models/inventory/labels.js";
import ColorLabel from "../../models/inventory/colorLabel.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Fix: Label/ColorLabel bindings (unlike Tape/TTR/POS Roll/Tafeta) don't
 * reference their owning user live via userId — they store their own
 * denormalized copy of clientName/userName/userContact, captured at
 * binding-creation time. If a user's name or contact is edited afterward
 * (e.g. via the client details "Edit User" form), those bindings keep the
 * OLD values forever — pages like /labels/view/:id read straight off the
 * binding, not the live Username doc, so the edit silently doesn't show up
 * there.
 *
 * This script finds every Label/ColorLabel binding whose stored
 * clientName/userName/userContact no longer matches its owning user's
 * current values, and re-syncs them. Unlike the location-orphan fix, there's
 * no ambiguity here — the live Username record is always the single correct
 * source — so every mismatch found gets fixed.
 *
 * Going forward, routes/fairdesk_route.js's POST /form/edit/user/:userId
 * calls the same sync automatically after every user edit (see
 * utils/reconcileBindingLocations.js -> syncLabelBindingIdentity), so this
 * script is only needed for pre-existing stale data.
 *
 * Defaults to a dry run (report only). Pass --apply to write the fixes.
 */

const APPLY = process.argv.includes("--apply");

const BINDING_TYPES = [
  [Label, "label", "Label"],
  [ColorLabel, "colorLabel", "ColorLabel"],
];

async function fixBindingType(Model, field, label) {
  const users = await Username.find({ [field]: { $exists: true, $ne: [] } })
    .select(`_id clientName userName userContact ${field}`)
    .populate({ path: field, select: "clientName userName userContact" })
    .lean();

  let checked = 0;
  let fixed = 0;
  const ops = [];

  for (const user of users) {
    const items = user[field] || [];
    for (const item of items) {
      if (!item) continue;
      checked += 1;

      const mismatch =
        item.clientName !== user.clientName ||
        item.userName !== user.userName ||
        item.userContact !== user.userContact;
      if (!mismatch) continue;

      fixed += 1;
      console.log(
        `  ${label} ${item._id} (user ${user._id}): ` +
        `clientName "${item.clientName}"->"${user.clientName}", ` +
        `userName "${item.userName}"->"${user.userName}", ` +
        `userContact "${item.userContact}"->"${user.userContact}"`,
      );

      if (APPLY) {
        ops.push({
          updateOne: {
            filter: { _id: item._id },
            update: { $set: { clientName: user.clientName, userName: user.userName, userContact: user.userContact } },
          },
        });
      }
    }
  }

  if (APPLY && ops.length) {
    await Model.collection.bulkWrite(ops, { ordered: false });
  }

  return { checked, fixed };
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

    const results = {};
    for (const [Model, field, label] of BINDING_TYPES) {
      console.log(`${label}:`);
      results[label] = await fixBindingType(Model, field, label);
      if (!results[label].fixed) console.log("  none found.");
      console.log("");
    }

    console.log("================ Summary ================");
    for (const [, , label] of BINDING_TYPES) {
      const r = results[label];
      console.log(`${label}: checked ${r.checked}, ${APPLY ? "fixed" : "would fix"} ${r.fixed}`);
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
