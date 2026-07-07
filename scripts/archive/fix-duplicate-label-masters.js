import mongoose from "mongoose";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import LabelMaster from "../models/inventory/labelMaster.js";
import ColorLabelMaster from "../models/inventory/colorLabelMaster.js";
import Label from "../models/inventory/labels.js";
import ColorLabel from "../models/inventory/colorLabel.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * One-off fix for master labels that got duplicated because their stored
 * `labelSignature` was hashed under an older version of
 * buildLabelMasterSignature() (routes/fairdesk_route.js) and so never
 * collided with a hash computed by the current formula, letting an
 * identical spec through the "already exists" check.
 *
 * For every group of masters that ARE byte-identical under the CURRENT
 * signature formula:
 *   - the master with the most client bindings (ties broken by oldest
 *     createdAt) is kept as the canonical record
 *   - every other master in the group has its bindings re-pointed to the
 *     canonical record, then has its `instructions` field overwritten with
 *     an explicit "DUPLICATE" marker and its signature recomputed from that
 *     new value (so it no longer collides with the canonical one and is
 *     obviously invalid if anyone opens it) instead of being deleted.
 *
 * Idempotent: safe to re-run. Pass --apply to write; defaults to a dry run.
 */

const APPLY = process.argv.includes("--apply");

function buildLabelMasterSignature(source) {
  return [
    String(source.jobType ?? "").trim().toUpperCase(),
    String(source.jobName ?? "").trim().toUpperCase(),
    String(source.instructions ?? "").trim().toUpperCase(),
    String(source.labelFamily ?? "").trim().toUpperCase(),
    String(source.labelWidth ?? "").trim(),
    String(source.labelHeight ?? "").trim(),
    String(source.labelGap ?? "").trim(),
    String(source.perRollQty ?? "").trim(),
    String(source.frontColor ?? "").trim(),
    String(source.backColor ?? "").trim(),
    String(source.varnish ?? "").trim().toUpperCase(),
    String(source.foilNo ?? "").trim(),
    String(source.firstOut ?? "").trim().toUpperCase(),
    String(source.paperType ?? "").trim().toUpperCase(),
    String(source.paperCode ?? "").trim().toUpperCase(),
  ].join("||");
}

function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}

const STALE_MARKER = "INVALID - DUPLICATE, DO NOT USE";

const BINDING_SYNC_FIELDS = [
  "jobType", "jobName", "instructions", "labelFamily", "paperType", "paperCode",
  "labelWidth", "labelHeight", "labelGap", "perRollQty",
  "frontColor", "backColor", "varnish", "foilNo", "firstOut",
];

async function fixFamily(MasterModel, BindingModel, familyName) {
  const masters = await MasterModel.find({}).lean();

  const bindingCounts = {};
  for (const m of masters) {
    bindingCounts[String(m._id)] = await BindingModel.countDocuments({ labelMasterId: m._id });
  }

  const groups = {};
  for (const m of masters) {
    const sig = hashSignature(buildLabelMasterSignature(m));
    (groups[sig] ||= []).push(m);
  }

  let groupsFound = 0;
  let bindingsMoved = 0;
  let mastersStaled = 0;

  for (const list of Object.values(groups)) {
    if (list.length < 2) continue;
    groupsFound++;

    // Canonical = most bindings, ties broken by oldest createdAt.
    const sorted = [...list].sort((a, b) => {
      const bindingDiff = bindingCounts[String(b._id)] - bindingCounts[String(a._id)];
      if (bindingDiff !== 0) return bindingDiff;
      return new Date(a.createdAt) - new Date(b.createdAt);
    });
    const canonical = sorted[0];
    const duplicates = sorted.slice(1);

    console.log(
      `\n[${familyName}] Duplicate group (${list.length} masters) -- keeping ${canonical.labelProductId} (${bindingCounts[String(canonical._id)]} bindings)`,
    );

    for (const dup of duplicates) {
      const dupBindings = await BindingModel.find({ labelMasterId: dup._id }).lean();
      console.log(
        `  -> ${dup.labelProductId} (${dupBindings.length} bindings) will be marked stale and merged into ${canonical.labelProductId}`,
      );

      for (const binding of dupBindings) {
        const set = { labelMasterId: canonical._id, productId: canonical.labelProductId };
        for (const field of BINDING_SYNC_FIELDS) {
          if (canonical[field] !== undefined) set[field] = canonical[field];
        }
        console.log(`     binding ${binding._id} (${binding.clientName}/${binding.userName}) -> ${canonical.labelProductId}`);
        if (APPLY) {
          await BindingModel.updateOne({ _id: binding._id }, { $set: set });
        }
        bindingsMoved++;
      }

      const staleInstructions = `${STALE_MARKER} (${canonical.labelProductId})`;
      const staleSignature = hashSignature(buildLabelMasterSignature({ ...dup, instructions: staleInstructions }));
      console.log(`     instructions -> "${staleInstructions}"`);
      if (APPLY) {
        await MasterModel.updateOne(
          { _id: dup._id },
          { $set: { instructions: staleInstructions, labelSignature: staleSignature } },
        );
      }
      mastersStaled++;
    }
  }

  return { groupsFound, bindingsMoved, mastersStaled };
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
  console.log(`Database connected.${APPLY ? "" : "  (DRY RUN — pass --apply to write changes)"}`);

  const plain = await fixFamily(LabelMaster, Label, "LABEL");
  const color = await fixFamily(ColorLabelMaster, ColorLabel, "COLOR");

  console.log("\n--- Summary ---");
  console.log(`Label masters:       duplicate groups ${plain.groupsFound}, bindings moved ${plain.bindingsMoved}, masters staled ${plain.mastersStaled}`);
  console.log(`Color label masters: duplicate groups ${color.groupsFound}, bindings moved ${color.bindingsMoved}, masters staled ${color.mastersStaled}`);
  if (!APPLY && plain.groupsFound + color.groupsFound > 0) {
    console.log("\nRe-run with --apply to write these changes.");
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
