import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import ProductionBinding from "../models/utilities/productionBinding.js";
import Paper from "../models/inventory/paper.js";

// ---------------------------------------------------------------------------
// One-time fix: a batch of ProductionBinding docs for vendor "SACHIKO
// PACKAGING" were created against prodPaperCode "A101" -- which was never a
// real Paper Master entry (Paper has no A101 under this vendor, only
// "FS | Paper | 000003" / prodCode "C011" / family CHROMO).
//
// Every field that identifies *which paper* the binding names is corrected
// to match that real Paper Master record: prodPaperCode -> "C011",
// prodPaperFamily -> "CHROMO" (already true on every match, so a no-op in
// practice), prodPaperRate -> the master's current rate (stored values were
// a stale "25", one "24" -- the same original mistake, not a deliberate
// per-binding override).
//
// Also sets paperId to the Paper document's own _id -- a real reference
// (see models/utilities/productionBinding.js), not free text. Once set,
// /fairtech/prodcalc/view and the details dialog show Paper Master's
// *current* rate for these bindings instead of a frozen snapshot, so a
// future rate change on this paper is reflected here without needing
// another one-time script.
//
// prodPaperSize is left alone -- that's the physical roll width the label
// itself needs, not an attribute of which paper vendor/code is used, so it
// isn't part of "which paper" identity and this fix has no opinion on it.
//
// Matches two groups, both scoped to this exact vendor+code, no fuzzy
// matching:
//   1. prodPaperCode "A101" (the actual typo) -- corrected in full.
//   2. prodPaperCode already "C011" but missing paperId -- bindings that
//      were already coded correctly before this script ever ran, just never
//      linked to the master doc (so their rate was equally stale and never
//      going to live-update). These get paperId + rate synced too, on the
//      reasoning that "already named the right paper" should mean "linked
//      to it", not "coincidentally spelled the same". Re-running this
//      script later is safe either way -- once every match has paperId set,
//      group 2 finds nothing and group 1 stays empty for good.
//
// Dry-run by default. Pass --apply to commit.
//
//   node scripts/fix-prodbinding-papercode-a101-to-c011.js           # preview
//   node scripts/fix-prodbinding-papercode-a101-to-c011.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");
const VENDOR = "SACHIKO PACKAGING";
const WRONG_CODE = "A101";
const CORRECT_CODE = "C011";

await connectDB();

const correctPaper = await Paper.findOne({
  vendorName: new RegExp(`^${VENDOR}$`, "i"),
  prodCode: new RegExp(`^${CORRECT_CODE}$`, "i"),
}).lean();

if (!correctPaper) {
  console.error(`Aborting: no active Paper Master entry found for "${VENDOR}" / "${CORRECT_CODE}".`);
  console.error("Nothing was changed.");
  process.exit(1);
}

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}`);
console.log(`Target paper: ${correctPaper.paperProductId} — ${correctPaper.vendorName} / ${correctPaper.prodCode} / ${correctPaper.family} / rate ${correctPaper.rate}\n`);

const bindings = await ProductionBinding.find({
  prodVendorName: new RegExp(`^${VENDOR}$`, "i"),
  $or: [
    { prodPaperCode: new RegExp(`^${WRONG_CODE}$`, "i") },
    { prodPaperCode: new RegExp(`^${CORRECT_CODE}$`, "i"), paperId: { $exists: false } },
  ],
}).lean();

console.log(`Bindings to fix/link under "${VENDOR}": ${bindings.length}\n`);

const correctRate = String(correctPaper.rate);

for (const b of bindings) {
  const wasWrongCode = String(b.prodPaperCode).toUpperCase() === WRONG_CODE;
  console.log(`${wasWrongCode ? "FIX     " : "LINK    "} _id ${b._id} — ${b.companyName || "N/A"}`);
  console.log(`           prodPaperCode   "${b.prodPaperCode}" -> "${CORRECT_CODE}"${wasWrongCode ? "" : " (already matched)"}`);
  console.log(`           prodPaperFamily "${b.prodPaperFamily}" -> "${correctPaper.family}"${b.prodPaperFamily === correctPaper.family ? " (already matched)" : ""}`);
  console.log(`           prodPaperRate   "${b.prodPaperRate}" -> "${correctRate}"${String(b.prodPaperRate) === correctRate ? " (already matched)" : ""}`);
  console.log(`           paperId         ${b.paperId || "—"} -> ${correctPaper._id}`);
  if (APPLY) {
    await ProductionBinding.updateOne(
      { _id: b._id },
      { $set: { prodPaperCode: CORRECT_CODE, prodPaperFamily: correctPaper.family, prodPaperRate: correctRate, paperId: correctPaper._id } },
    );
  }
}

console.log(`\n${APPLY ? `Updated ${bindings.length} binding(s).` : "Dry-run only. Re-run with --apply to commit."}`);

await ProductionBinding.db.close();
process.exit(0);
