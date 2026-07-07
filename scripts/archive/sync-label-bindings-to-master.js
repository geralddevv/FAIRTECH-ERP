import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import LabelMaster from "../../models/inventory/labelMaster.js";
import ColorLabelMaster from "../../models/inventory/colorLabelMaster.js";
import Label from "../../models/inventory/labels.js";
import ColorLabel from "../../models/inventory/colorLabel.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Backfill: sync master-owned spec fields (instructions, labelWidth,
 * labelHeight, labelGap) from LabelMaster/ColorLabelMaster down to every
 * existing client binding (Label/ColorLabel).
 *
 * Bindings snapshot these fields from the master at creation time
 * (POST /form/labels, /form/color-labels). Editing a master via
 * /fairtech/labels/edit/:id previously updated only the master, leaving
 * already-created bindings — and everything that reads them live
 * (sales order confirm page, pending production, etc.) — stale. The route
 * now pushes edits down going forward; this script fixes bindings that
 * already drifted before that fix existed.
 *
 * Idempotent: safe to re-run. Pass --apply to write; defaults to a dry run.
 */

const APPLY = process.argv.includes("--apply");
const SPEC_FIELDS = ["instructions", "labelWidth", "labelHeight", "labelGap"];

async function syncFamily(MasterModel, BindingModel, familyName, fields) {
  const masters = await MasterModel.find({}).lean();
  let scanned = 0;
  let mismatched = 0;
  let updated = 0;

  for (const master of masters) {
    const bindings = await BindingModel.find({ labelMasterId: master._id }).lean();
    for (const binding of bindings) {
      scanned++;
      const diff = {};
      for (const field of fields) {
        const masterVal = master[field] ?? "";
        const bindingVal = binding[field] ?? "";
        if (String(masterVal) !== String(bindingVal)) diff[field] = masterVal;
      }
      if (Object.keys(diff).length === 0) continue;

      mismatched++;
      console.log(
        `[${familyName}] ${master.labelProductId} -> binding ${binding._id} (${binding.clientName}/${binding.userName}): ` +
          Object.entries(diff).map(([k, v]) => `${k}: "${binding[k] ?? ""}" -> "${v}"`).join(", "),
      );

      if (APPLY) {
        await BindingModel.updateOne({ _id: binding._id }, { $set: diff });
        updated++;
      }
    }
  }

  return { scanned, mismatched, updated };
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

  const plain = await syncFamily(LabelMaster, Label, "LABEL", SPEC_FIELDS);
  // ColorLabelMaster/ColorLabel have no `instructions` field.
  const color = await syncFamily(ColorLabelMaster, ColorLabel, "COLOR", SPEC_FIELDS.filter((f) => f !== "instructions"));

  console.log("\n--- Summary ---");
  console.log(`Label bindings:       scanned ${plain.scanned}, mismatched ${plain.mismatched}, updated ${plain.updated}`);
  console.log(`Color label bindings: scanned ${color.scanned}, mismatched ${color.mismatched}, updated ${color.updated}`);
  if (!APPLY && plain.mismatched + color.mismatched > 0) {
    console.log("\nRe-run with --apply to write these changes.");
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
