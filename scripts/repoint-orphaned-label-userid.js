import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import Username from "../models/users/username.js";
import Label from "../models/inventory/labels.js";
import ColorLabel from "../models/inventory/colorLabel.js";

// ---------------------------------------------------------------------------
// Repair Label / Color Label bindings whose `userId` points at a Username
// document that no longer exists.
//
// userId is the *live* reference a binding's row uses to resolve current
// account fields (Client Type among them) -- clientName/userName/userContact
// are only a denormalized snapshot kept for legacy readers, and Client Type
// was never snapshotted at all. So when a client's account gets recreated
// (a new Username _id) instead of edited in place, older bindings still
// pointing at the deleted _id populate userId as null and silently lose
// Client Type on every page that reads it live (e.g.
// /fairtech/labels/production-binding/pending) -- clientName/userName still
// show fine because those do fall back to the snapshot.
//
// This only relinks a binding when exactly one *current* Username document
// matches its own snapshot (clientName + userName + location) -- an
// unambiguous "this is clearly the same account under a new id". Anything
// else is left for a human to decide.
//
// Before reattaching, it also checks whether the target account already has
// a binding with the SAME IDENTITY the create route itself would refuse to
// duplicate (see "Block duplicate only when master + ups + core + family all
// match" for Label, and the equivalent masterId+location check for ColorLabel
// in routes/fairdesk_route.js). Without this, `$addToSet` on the target's
// label/colorLabel array only blocks adding the exact same _id twice -- it
// has no idea the account already picked up an equivalent-spec binding under
// a different _id in the meantime (e.g. the client was re-bound fresh after
// its account got recreated, before this script got around to repointing the
// old one). That silent gap is exactly how the "same same" duplicate pairs
// documented in CLAUDE.md ("Duplicate plain Label bindings") were created --
// see scripts/report-duplicate-label-bindings.js for the existing ones. A
// match here is left for a human instead of merged automatically, since
// either _id may already be referenced by an order or a ProductionBinding.
//
// Dry-run by default; pass --apply to write.
//
//   node scripts/repoint-orphaned-label-userid.js             # report
//   node scripts/repoint-orphaned-label-userid.js --apply     # fix the unambiguous ones
// ---------------------------------------------------------------------------

const APPLY = process.argv.slice(2).includes("--apply");

const canonical = (value) =>
  String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ");

await connectDB();

const usernames = await Username.find({}, { clientName: 1, userName: 1, userLocation: 1, label: 1, colorLabel: 1 }).lean();
const existingUsernameIds = new Set(usernames.map((u) => String(u._id)));
const usernameById = new Map(usernames.map((u) => [String(u._id), u]));

// Index current Username docs by (clientName, userName, location) so an
// orphaned binding's own snapshot can be matched back to whichever current
// account it belongs to.
const usernameByKey = new Map();
for (const u of usernames) {
  const key = `${canonical(u.clientName)}||${canonical(u.userName)}||${canonical(u.userLocation)}`;
  if (!usernameByKey.has(key)) usernameByKey.set(key, []);
  usernameByKey.get(key).push(u);
}

// Same identity each model's own create-route duplicate guard uses -- see
// the long comment above.
const MODELS = [
  {
    name: "Label",
    Model: Label,
    field: "label",
    extraSelect: { labelMasterId: 1, labelUps: 1, labelCore: 1, labelFamily: 1 },
    identityKey: (d) =>
      [
        String(d.labelMasterId || ""),
        String(d.labelUps || "").trim(),
        String(d.labelCore || "").trim(),
        String(d.labelFamily || "").trim(),
        String(d.location || "").trim(),
      ].join("|"),
  },
  {
    name: "ColorLabel",
    Model: ColorLabel,
    field: "colorLabel",
    extraSelect: { labelMasterId: 1 },
    identityKey: (d) => [String(d.labelMasterId || ""), String(d.location || "").trim()].join("|"),
  },
];

let totalOrphaned = 0;
let fixed = 0;
let ambiguous = 0;
let skippedDuplicate = 0;

for (const { name, Model, field, extraSelect, identityKey } of MODELS) {
  const docs = await Model.find(
    {},
    { userId: 1, clientName: 1, userName: 1, location: 1, status: 1, jobName: 1, ...extraSelect },
  ).lean();
  const docsById = new Map(docs.map((d) => [String(d._id), d]));

  const orphaned = docs.filter((d) => d.userId && !existingUsernameIds.has(String(d.userId)));
  if (!orphaned.length) continue;

  console.log(`\n=== ${name}: ${orphaned.length} orphaned binding(s) ===`);

  for (const doc of orphaned) {
    totalOrphaned++;
    const label = `${doc._id}  ${String(doc.clientName || "-").padEnd(24)} ${String(doc.userName || "-").padEnd(20)} ${String(doc.location || "-").padEnd(12)} ${doc.status}`;
    const key = `${canonical(doc.clientName)}||${canonical(doc.userName)}||${canonical(doc.location)}`;
    const candidates = usernameByKey.get(key) || [];

    console.log(label);
    console.log(`  dead userId : ${doc.userId}`);

    if (candidates.length !== 1) {
      console.log(
        `  --> NEEDS A DECISION: ${candidates.length === 0 ? "no current account matches this binding's client/user/location" : `${candidates.length} current accounts match -- ambiguous`}.`,
      );
      ambiguous++;
      continue;
    }

    const target = candidates[0];
    // Read + mutate the shared targetDoc.* array in place (not a copy) --
    // an earlier orphaned doc in this same run matching the same target may
    // already have been pushed onto it below, and the next one needs to see
    // that too, not just what was in the original find().
    const targetDoc = usernameById.get(String(target._id));
    if (targetDoc && !Array.isArray(targetDoc[field])) targetDoc[field] = [];
    const targetArray = targetDoc ? targetDoc[field] : [];
    const wantedKey = identityKey(doc);
    const dupeId = targetArray
      .map(String)
      .find((id) => id !== String(doc._id) && docsById.has(id) && identityKey(docsById.get(id)) === wantedKey);

    if (dupeId) {
      console.log(
        `  --> SKIPPED: target account already has an identical-spec binding (${dupeId}) -- reattaching this one would create the exact "same same" duplicate documented in CLAUDE.md. Needs a human decision (keep which one?).`,
      );
      skippedDuplicate++;
      continue;
    }

    console.log(`  --> ${APPLY ? "set" : "would set"} userId = ${target._id} (current account for the same client/user/location)`);
    if (APPLY) {
      await Model.updateOne({ _id: doc._id }, { $set: { userId: target._id } });
      // Keep the account's own label/colorLabel list in step, same as a
      // normal binding create would have done.
      await Username.updateOne({ _id: target._id }, { $addToSet: { [field]: doc._id } });
      if (targetDoc) targetArray.push(String(doc._id)); // so a later orphan in this same run sees it too
    }
    fixed++;
  }
}

if (totalOrphaned === 0) {
  console.log("No orphaned Label / Color Label bindings found.");
} else {
  console.log(
    `\n${totalOrphaned} orphaned binding(s) total: ${fixed} ${APPLY ? "repaired" : "repairable"}, ${ambiguous} need a decision, ${skippedDuplicate} skipped (target already has an identical-spec binding).`,
  );
  if (!APPLY && fixed > 0) console.log("Dry run -- re-run with --apply to write.");
}

await mongoose.disconnect();
