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

const usernames = await Username.find({}, { clientName: 1, userName: 1, userLocation: 1 }).lean();
const existingUsernameIds = new Set(usernames.map((u) => String(u._id)));

// Index current Username docs by (clientName, userName, location) so an
// orphaned binding's own snapshot can be matched back to whichever current
// account it belongs to.
const usernameByKey = new Map();
for (const u of usernames) {
  const key = `${canonical(u.clientName)}||${canonical(u.userName)}||${canonical(u.userLocation)}`;
  if (!usernameByKey.has(key)) usernameByKey.set(key, []);
  usernameByKey.get(key).push(u);
}

const MODELS = [
  { name: "Label", Model: Label },
  { name: "ColorLabel", Model: ColorLabel },
];

let totalOrphaned = 0;
let fixed = 0;
let ambiguous = 0;

for (const { name, Model } of MODELS) {
  const docs = await Model.find(
    { userId: { $ne: null } },
    { userId: 1, clientName: 1, userName: 1, location: 1, status: 1, jobName: 1 },
  ).lean();

  const orphaned = docs.filter((d) => !existingUsernameIds.has(String(d.userId)));
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
    console.log(`  --> ${APPLY ? "set" : "would set"} userId = ${target._id} (current account for the same client/user/location)`);
    if (APPLY) {
      await Model.updateOne({ _id: doc._id }, { $set: { userId: target._id } });
      // Keep the account's own label/colorLabel list in step, same as a
      // normal binding create would have done.
      const field = name === "ColorLabel" ? "colorLabel" : "label";
      await Username.updateOne({ _id: target._id }, { $addToSet: { [field]: doc._id } });
    }
    fixed++;
  }
}

if (totalOrphaned === 0) {
  console.log("No orphaned Label / Color Label bindings found.");
} else {
  console.log(
    `\n${totalOrphaned} orphaned binding(s) total: ${fixed} ${APPLY ? "repaired" : "repairable"}, ${ambiguous} need a decision.`,
  );
  if (!APPLY && fixed > 0) console.log("Dry run -- re-run with --apply to write.");
}

await mongoose.disconnect();
