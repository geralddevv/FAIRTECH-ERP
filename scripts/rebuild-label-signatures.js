import { fileURLToPath } from "url";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import LabelMaster from "../models/inventory/labelMaster.js";
import ColorLabelMaster from "../models/inventory/colorLabelMaster.js";
import Label from "../models/inventory/labels.js";
import ColorLabel from "../models/inventory/colorLabel.js";

// ---------------------------------------------------------------------------
// Repair for Master Label duplicate protection.
//
// labelSignature was only ever computed at create time. Editing a label's
// spec (width/height/gap/instructions, via POST /fairtech/labels/edit/:id)
// updated the document but left its labelSignature exactly as it was at
// creation -- so a label edited from e.g. 40x40 to 80x80 kept the 40x40
// hash. Two visible symptoms: the edited label's new spec was never checked
// against other labels for a collision, AND a brand-new label later created
// at the label's *old* spec (40x40) was wrongly rejected as a duplicate of
// it, even though nothing on file actually matched anymore.
//
// Fixed going forward in routes/fairdesk_route.js's POST /labels/edit/:id
// (recomputes + checks on every save). This script repairs every label
// already sitting on a stale signature.
//
// This recomputes every label's signature from its CURRENT fields. If two
// labels' current specs now genuinely collide (only possible because the
// duplicate check was silently skipped on every past edit), only one may
// hold the signature -- the unique index allows nothing else. The keeper is
// whichever has more client bindings against it (i.e. actually in use),
// oldest wins a tie; the other is listed as DUPLICATE below with its
// signature cleared so it keeps working but no longer blocks anything --
// you should look at those and decide whether to fix one of the specs.
//
// Covers both plain (LabelMaster / "labels") and color (ColorLabelMaster /
// "colorlabels") masters -- separate collections, separate unique index,
// checked independently.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/rebuild-label-signatures.js          # preview
//   node scripts/rebuild-label-signatures.js --apply  # commit
// ---------------------------------------------------------------------------

// MUST stay identical to buildLabelMasterSignature / hashSignature in
// routes/fairdesk_route.js, or the rebuilt signatures won't match what the
// live create/edit routes compute.
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
function hashSignature(raw) {
  return `sha256:${crypto.createHash("sha256").update(String(raw ?? "")).digest("hex")}`;
}

const APPLY = process.argv.includes("--apply");

await connectDB();

async function rebuild(Model, BindingModel, modelLabel) {
  const docs = await Model.find().select("labelProductId labelSignature createdAt").lean();
  const full = await Model.find().lean(); // need every field for the signature itself
  const byId = new Map(full.map((d) => [String(d._id), d]));

  const bindingCounts = new Map(
    (
      await BindingModel.aggregate([{ $group: { _id: "$labelMasterId", n: { $sum: 1 } } }])
    ).map((row) => [String(row._id), Number(row.n) || 0]),
  );

  console.log(`\n=== ${modelLabel} ===`);
  console.log(`Documents: ${docs.length}`);

  // Group by the signature each doc SHOULD hash to.
  const groups = new Map(); // raw identity -> docs
  for (const stub of docs) {
    const doc = byId.get(String(stub._id));
    const raw = buildLabelMasterSignature(doc);
    if (!groups.has(raw)) groups.set(raw, []);
    groups.get(raw).push(doc);
  }

  const label = (doc) => `${doc.labelProductId || "?"} (_id ${doc._id})`;

  const toClear = [];
  const toSet = [];
  const duplicates = [];

  for (const [raw, group] of groups) {
    const signature = hashSignature(raw);
    // Sort oldest first so a tie-break picks the longest-standing document.
    group.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    const keeper = group.reduce((best, doc) =>
      (bindingCounts.get(String(doc._id)) || 0) > (bindingCounts.get(String(best._id)) || 0) ? doc : best,
    );

    for (const doc of group) {
      if (doc === keeper) continue;
      if (doc.labelSignature) toClear.push(doc);
      duplicates.push({ doc, keeper, raw });
    }

    if (keeper.labelSignature !== signature) {
      if (keeper.labelSignature) toClear.push(keeper);
      toSet.push({ doc: keeper, signature, raw });
    }
  }

  for (const { doc, keeper, raw } of duplicates) {
    console.log(`DUPLICATE ${label(doc)}`);
    console.log(`           same spec as ${label(keeper)}  [${raw}]`);
    console.log(`           signature cleared -- review and reconcile these two`);
  }

  for (const { doc, signature, raw } of toSet) {
    const was = doc.labelSignature ? `${doc.labelSignature.slice(0, 24)}...` : "(none)";
    console.log(`REBUILD   ${label(doc)}`);
    console.log(`           ${was} -> ${signature.slice(0, 24)}...  [${raw}]`);
  }

  if (APPLY) {
    // Clear first, then set: a stale signature on one doc can be exactly the
    // signature another doc needs, and the unique index would reject the
    // write if both existed at once.
    if (toClear.length) {
      await Model.updateMany({ _id: { $in: toClear.map((d) => d._id) } }, { $unset: { labelSignature: "" } });
    }
    for (const { doc, signature } of toSet) {
      await Model.updateOne({ _id: doc._id }, { $set: { labelSignature: signature } });
    }
  }

  console.log(`--- ${modelLabel} summary ---`);
  console.log(`Rebuilt:         ${toSet.length}`);
  console.log(`Already correct: ${docs.length - duplicates.length - toSet.length}`);
  console.log(`Duplicates:      ${duplicates.length}`);
}

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}`);

await rebuild(LabelMaster, Label, "LabelMaster (plain)");
await rebuild(ColorLabelMaster, ColorLabel, "ColorLabelMaster (color)");

console.log(`\n${APPLY ? "Changes committed." : "\nDry-run only. Re-run with --apply to commit."}`);

await LabelMaster.db.close();
process.exit(0);
