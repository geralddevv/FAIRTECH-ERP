import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import Username from "../models/users/username.js";
import Label from "../models/inventory/labels.js";
import ColorLabel from "../models/inventory/colorLabel.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Backfill: Label and ColorLabel bindings now carry a live `userId` reference
 * (matching how Tape/TTR/POS Roll/Tafeta bindings already work), instead of
 * relying solely on a denormalized clientName/userName/userContact snapshot
 * that goes stale whenever the user's details are edited afterward.
 *
 * Existing bindings predate this field, so this script backfills it. The
 * source of truth is the Username.label / Username.colorLabel arrays — each
 * Username document already lists exactly which bindings belong to it, so
 * this is a direct, unambiguous assignment (no fuzzy clientName/userName
 * matching needed, unlike scripts/migrate-binding-location.js).
 *
 * Idempotent: bindings that already have the correct userId are skipped, so
 * re-running makes no further changes. Pass --apply to write; defaults to a
 * dry run.
 */

const APPLY = process.argv.includes("--apply");
const BATCH_SIZE = 500;

async function backfill(Model, field, label) {
  const users = await Username.find({ [field]: { $exists: true, $ne: [] } })
    .select(`_id ${field}`)
    .lean();

  let checked = 0;
  let updated = 0;
  let ops = [];

  for (const user of users) {
    const ids = user[field] || [];
    for (const id of ids) {
      checked += 1;
      ops.push({
        updateOne: {
          filter: { _id: id, userId: { $ne: user._id } },
          update: { $set: { userId: user._id } },
        },
      });
    }
  }

  if (APPLY) {
    // bulkWrite in batches; matchedCount/modifiedCount only reflect docs that
    // actually needed the update (filter excludes already-correct ones).
    for (let i = 0; i < ops.length; i += BATCH_SIZE) {
      const batch = ops.slice(i, i + BATCH_SIZE);
      const result = await Model.collection.bulkWrite(batch, { ordered: false });
      updated += result.modifiedCount || 0;
    }
  } else {
    // Dry run: figure out how many would actually change.
    const bindingIds = ops.map((op) => op.updateOne.filter._id);
    if (bindingIds.length) {
      const existing = await Model.find({ _id: { $in: bindingIds } }).select("_id userId").lean();
      const userIdByBinding = new Map();
      for (const user of users) {
        for (const id of user[field] || []) userIdByBinding.set(String(id), String(user._id));
      }
      for (const doc of existing) {
        const correctUserId = userIdByBinding.get(String(doc._id));
        if (String(doc.userId || "") !== correctUserId) updated += 1;
      }
    }
  }

  console.log(`  ${label}: checked ${checked}, ${APPLY ? "updated" : "would update"} ${updated}`);
  return { checked, updated };
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

    const labelResult = await backfill(Label, "label", "Label");
    const colorLabelResult = await backfill(ColorLabel, "colorLabel", "ColorLabel");

    console.log("\n================ Summary ================");
    console.log(`Label: checked ${labelResult.checked}, ${APPLY ? "updated" : "would update"} ${labelResult.updated}`);
    console.log(`ColorLabel: checked ${colorLabelResult.checked}, ${APPLY ? "updated" : "would update"} ${colorLabelResult.updated}`);
    console.log("==========================================");
    console.log(APPLY ? "Done — changes written." : "Dry run complete — re-run with --apply to write these changes.");

    process.exit(0);
  } catch (err) {
    console.error("Backfill script failed:", err);
    process.exit(1);
  }
}

run();
