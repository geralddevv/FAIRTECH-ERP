import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import Username from "../models/users/username.js";
import Label from "../models/inventory/labels.js";

// ---------------------------------------------------------------------------
// Report: plain Label bindings that are exact duplicates of each other on the
// same user -- same master label, ups, core, family and location, i.e. the
// very identity POST /form/labels itself refuses to create twice (see
// "Block duplicate only when master + ups + core + family all match" in
// routes/fairdesk_route.js). Seeing two of them on one account means that
// guard got bypassed somewhere, not that it's missing.
//
// READ-ONLY. This script never writes to the database.
//
// The one bypass route found so far: scripts/repoint-orphaned-label-userid.js
// relinks a binding whose userId points at a deleted Username back onto
// today's matching account via `$addToSet` on that account's `label` array.
// $addToSet only blocks adding the exact same _id twice -- if that account
// already picked up a fresh binding with the same spec in the meantime (e.g.
// the client's record was recreated and the label was bound again under the
// new _id before the old one got repointed), the old binding is reattached
// right alongside it with no spec check at all. That produces exactly the
// "same same" pairs this script finds: one row from the original bind date,
// one from whenever the account was re-bound, both under the same Username.
//
// This only reports -- it does not delete or merge anything. Two bindings
// that are identical right now may not be safe to collapse blindly (orders,
// ProductionBinding links, etc. may reference either _id), so which one to
// keep is a human decision.
//
//   node scripts/report-duplicate-label-bindings.js
//   node scripts/report-duplicate-label-bindings.js --csv=out.csv
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const csvArg = args.find((a) => a.startsWith("--csv="));
const CSV_PATH = csvArg ? csvArg.slice("--csv=".length) : null;

await connectDB();

const users = await Username.find({ label: { $exists: true, $ne: [] } })
  .select("clientName userName userLocation label")
  .lean();

const labelIds = users.flatMap((u) => u.label || []);
const labels = await Label.find({ _id: { $in: labelIds } })
  .select("userId labelMasterId labelUps labelCore labelFamily location productId jobName ratePerK status")
  .lean();
// Label has no timestamps: true, so there is no createdAt field on the
// document -- every ObjectId carries its own creation time in its first 4
// bytes regardless, which is the only reliable "when was this bound" here.
labels.forEach((l) => { l.createdAt = l._id.getTimestamp(); });
const labelById = new Map(labels.map((l) => [String(l._id), l]));

// Same identity key as the create-time duplicate guard, scoped to one user's
// own `label` array (never across users -- two different clients are allowed
// to share a spec).
const identityKey = (l) =>
  [
    String(l.labelMasterId || ""),
    String(l.labelUps || "").trim(),
    String(l.labelCore || "").trim(),
    String(l.labelFamily || "").trim(),
    String(l.location || "").trim(),
  ].join("|");

const groups = []; // { user, rows: [label, ...] }
let totalDupeRows = 0;

for (const user of users) {
  const own = (user.label || [])
    .map((id) => labelById.get(String(id)))
    .filter(Boolean);

  const byKey = new Map();
  for (const l of own) {
    const k = identityKey(l);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(l);
  }

  for (const rows of byKey.values()) {
    if (rows.length < 2) continue;
    rows.sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0));
    groups.push({ user, rows });
    totalDupeRows += rows.length - 1; // all but the first are "extra"
  }
}

console.log("");
console.log("=".repeat(78));
console.log("  PLAIN LABEL BINDINGS -- EXACT DUPLICATES ON THE SAME USER");
console.log("=".repeat(78));
console.log("");
console.log(`  Users with any label binding : ${users.length}`);
console.log(`  Duplicate groups             : ${groups.length}`);
console.log(`  Extra (removable) rows       : ${totalDupeRows}`);
console.log("");

if (!groups.length) {
  console.log("  None found.");
} else {
  console.log("-".repeat(78));
  for (const { user, rows } of groups) {
    console.log(`  ${user.clientName || "—"} / ${user.userName || "—"}  (${user.userLocation || "—"})`);
    console.log(`     product ${rows[0].productId || "—"}  |  job ${rows[0].jobName || "—"}`);
    rows.forEach((r, i) => {
      const when = r.createdAt ? new Date(r.createdAt).toISOString().slice(0, 10) : "—";
      const tag = i === 0 ? "keep?" : "DUPE ";
      console.log(`     [${tag}] ${r._id}  created ${when}  rate ${r.ratePerK || "—"}  status ${r.status || "—"}  /fairtech/labels-binding/edit/${r._id}`);
    });
    console.log("");
  }
  console.log("-".repeat(78));
}

if (CSV_PATH) {
  const esc = (v) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ["bindingId", "clientName", "userName", "location", "productId", "jobName", "createdAt", "ratePerK", "status", "groupSeq", "editUrl"];
  const lines = [header.join(",")];
  groups.forEach((g, gi) => {
    g.rows.forEach((r) => {
      lines.push(
        [
          String(r._id), g.user.clientName, g.user.userName, g.user.userLocation,
          r.productId, r.jobName, r.createdAt, r.ratePerK, r.status, gi + 1,
          `/fairtech/labels-binding/edit/${r._id}`,
        ].map(esc).join(","),
      );
    });
  });
  fs.writeFileSync(path.resolve(CSV_PATH), lines.join("\n") + "\n", "utf8");
  console.log(`  CSV written: ${path.resolve(CSV_PATH)}  (${lines.length - 1} rows)`);
  console.log("");
}

console.log("=".repeat(78));
console.log("  Read-only report. Nothing was written to the database.");
console.log("=".repeat(78));
console.log("");

await mongoose.disconnect();
process.exit(0);
