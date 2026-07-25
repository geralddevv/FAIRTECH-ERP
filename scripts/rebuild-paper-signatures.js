import { fileURLToPath } from "url";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import Paper from "../models/inventory/paper.js";
import PaperStock from "../models/inventory/PaperStock.js";

// ---------------------------------------------------------------------------
// Repair for Paper Master duplicate protection.
//
// A paper's identity is Vendor + Prod Code + Family (rate is an attribute of
// that identity, not part of it -- and note family only joined the identity
// after the first papers were created, so signatures written before that need
// this rebuild). The create route blocks duplicates by looking up
// the hashed paperSignature, and the index on it is UNIQUE + SPARSE. So a paper
// whose stored signature is missing, or was computed under an older formula, is
// invisible to the dup check -- the same vendor + prod code can be created
// again -- while a signature left over from a since-edited vendor/prod code can
// block a genuinely new paper from being created at all.
//
// This recomputes every paper's signature from its CURRENT vendor + prod code.
// Where several papers share one identity, only one may hold the signature
// (the unique index allows nothing else): the copy with stock rows against it
// wins, oldest first as a tie-break. The losers have their signature cleared
// and are listed as MERGE below -- they keep working, but you should decide
// what happens to them, because the dup check will now point every new entry at
// the keeper.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/rebuild-paper-signatures.js          # preview
//   node scripts/rebuild-paper-signatures.js --apply  # commit
// ---------------------------------------------------------------------------

// These MUST stay identical to routes/fairdesk_route.js (buildPaperSignature /
// normalizeTapePart / hashSignature) and routes/stock/paperStock.js, or the
// rebuilt signatures won't match the ones the live routes compute.
function normalizePaperPart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}
function buildPaperSignature(source) {
  return [
    normalizePaperPart(source.vendorName).toUpperCase(),
    normalizePaperPart(source.prodCode).toUpperCase(),
    normalizePaperPart(source.family).toUpperCase(),
  ].join("||");
}
function hashSignature(raw) {
  return `sha256:${crypto.createHash("sha256").update(String(raw ?? "")).digest("hex")}`;
}

const APPLY = process.argv.includes("--apply");

await connectDB();

const papers = await Paper.find()
  .select("paperProductId vendorName prodCode family paperSignature createdAt")
  .sort({ createdAt: 1, _id: 1 })
  .lean();

// One reel per PaperStock row; used only to decide which copy of a duplicated
// identity is the one actually in use.
const stockCounts = new Map(
  (
    await PaperStock.aggregate([{ $group: { _id: "$paper", rows: { $sum: 1 } } }])
  ).map((row) => [String(row._id), Number(row.rows) || 0]),
);

console.log(`Papers: ${papers.length}`);
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

// Group by the identity each paper SHOULD hash to.
const groups = new Map(); // raw identity -> papers
const invalid = [];
for (const paper of papers) {
  const raw = buildPaperSignature(paper);
  // Nothing identifying at all — every part blank.
  if (raw.split("||").every((part) => !part)) {
    invalid.push(paper);
    continue;
  }
  if (!groups.has(raw)) groups.set(raw, []);
  groups.get(raw).push(paper);
}

const label = (paper) =>
  `${paper.paperProductId || "?"} — ${paper.vendorName || "?"} / ${paper.prodCode || "?"} / ${paper.family || "?"} (_id ${paper._id})`;

const toClear = []; // signature must go away (stale, or a duplicate's)
const toSet = []; // keeper -> correct signature
const merges = [];

for (const [raw, docs] of groups) {
  const signature = hashSignature(raw);

  // The copy with stock against it is the live one; oldest wins a tie (the
  // list is already sorted oldest first).
  const keeper = docs.reduce((best, doc) =>
    (stockCounts.get(String(doc._id)) || 0) > (stockCounts.get(String(best._id)) || 0) ? doc : best,
  );

  for (const doc of docs) {
    if (doc === keeper) continue;
    if (doc.paperSignature) toClear.push(doc);
    merges.push({ doc, keeper, raw });
  }

  if (keeper.paperSignature !== signature) {
    if (keeper.paperSignature) toClear.push(keeper);
    toSet.push({ doc: keeper, signature, raw });
  }
}

for (const paper of invalid) {
  console.log(`SKIP     ${label(paper)}`);
  console.log(`           no vendor name, prod code or family — cannot build a signature`);
}

for (const { doc, keeper, raw } of merges) {
  console.log(`MERGE    ${label(doc)}`);
  console.log(`           same identity as ${keeper.paperProductId || keeper._id}  [${raw}]`);
  console.log(`           signature cleared — new entries for this spec will resolve to the keeper`);
}

for (const { doc, signature, raw } of toSet) {
  const was = doc.paperSignature ? `${doc.paperSignature.slice(0, 24)}...` : "(none)";
  console.log(`REBUILD  ${label(doc)}`);
  console.log(`           ${was} -> ${signature.slice(0, 24)}...  [${raw}]`);
}

if (APPLY) {
  // Clear first, then set: a stale signature on one paper is often exactly the
  // signature another paper needs, and the unique index would reject the write
  // if both existed at once.
  if (toClear.length) {
    await Paper.updateMany(
      { _id: { $in: toClear.map((doc) => doc._id) } },
      { $unset: { paperSignature: "" } },
    );
  }
  for (const { doc, signature } of toSet) {
    await Paper.updateOne({ _id: doc._id }, { $set: { paperSignature: signature } });
  }
}

console.log(`\n--- Summary ---`);
console.log(`Rebuilt:        ${toSet.length}`);
console.log(`Already correct:${papers.length - invalid.length - merges.length - toSet.length}`);
console.log(`Duplicates:     ${merges.length}`);
console.log(`Unsignable:     ${invalid.length}`);
console.log(APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit.");

await Paper.db.close();
process.exit(0);
