import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import ProductionBinding from "../models/utilities/productionBinding.js";
import Paper from "../models/inventory/paper.js";

// ---------------------------------------------------------------------------
// ProductionBinding.prodPaperCode / prodPaperFamily / prodVendorName /
// prodPaperRate are free-text snapshots taken at bind time (see the header
// comment in models/utilities/productionBinding.js). Of those, only
// prodPaperRate is re-resolved live -- routes/fairdesk_route.js's
// withLiveRate() swaps it for the Paper Master's *current* rate on every
// /prodcalc/view load, via the real paperId reference. Code/family/vendor are
// never re-synced: editing a Paper Master row (e.g. correcting its Prod Code)
// leaves every binding that names it showing the old text forever, in every
// consumer that reads these fields straight off the binding --
// routes/system/machine.js (job card / production queue display),
// routes/inventory/paperReorder.js (reorder grouping), and the
// /prodcalc/view?paperId= "B Clients" link (routes/fairdesk_route.js), which
// filters by matching this stored text against the paper's current
// vendor+code and so silently returns nothing once they drift apart.
//
// This script re-syncs those three text fields (+ rate, belt-and-suspenders
// in case a binding was created/edited outside the live-rate path) from
// Paper Master, for every binding that has a resolvable paperId. Bindings
// without paperId (older ones, or outsourced bindings which have no paper
// side by design -- see "Outsourced labels" in CLAUDE.md) are left alone,
// same as withLiveRate()'s own fallback.
//
// General-purpose and safe to re-run any time a Paper Master vendor/code/
// family/rate is edited -- it only ever writes when the stored snapshot
// differs from the current master, and does nothing once they match.
//
// Dry-run by default. Pass --apply to commit.
//
//   node scripts/sync-prodbinding-paper-fields.js           # preview
//   node scripts/sync-prodbinding-paper-fields.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

const bindings = await ProductionBinding.find({ paperId: { $exists: true, $ne: null } }).lean();
console.log(`Bindings with paperId: ${bindings.length}`);

const paperIds = [...new Set(bindings.map((b) => String(b.paperId)))];
const papers = await Paper.find({ _id: { $in: paperIds } })
  .select("vendorName prodCode family rate")
  .lean();
const paperById = new Map(papers.map((p) => [String(p._id), p]));

let fixed = 0;
let missingPaper = 0;

for (const b of bindings) {
  const paper = paperById.get(String(b.paperId));
  if (!paper) {
    missingPaper++;
    continue;
  }

  const rate = String(paper.rate);
  const drift = {
    prodVendorName: b.prodVendorName !== paper.vendorName,
    prodPaperCode: b.prodPaperCode !== paper.prodCode,
    prodPaperFamily: b.prodPaperFamily !== paper.family,
    prodPaperRate: String(b.prodPaperRate) !== rate,
  };
  if (!Object.values(drift).some(Boolean)) continue;

  fixed++;
  console.log(`FIX _id ${b._id} — ${b.companyName || "N/A"}`);
  if (drift.prodVendorName) console.log(`     prodVendorName   "${b.prodVendorName}" -> "${paper.vendorName}"`);
  if (drift.prodPaperCode) console.log(`     prodPaperCode    "${b.prodPaperCode}" -> "${paper.prodCode}"`);
  if (drift.prodPaperFamily) console.log(`     prodPaperFamily  "${b.prodPaperFamily}" -> "${paper.family}"`);
  if (drift.prodPaperRate) console.log(`     prodPaperRate    "${b.prodPaperRate}" -> "${rate}"`);

  if (APPLY) {
    await ProductionBinding.updateOne(
      { _id: b._id },
      {
        $set: {
          prodVendorName: paper.vendorName,
          prodPaperCode: paper.prodCode,
          prodPaperFamily: paper.family,
          prodPaperRate: rate,
        },
      },
    );
  }
}

if (missingPaper) {
  console.log(`\n${missingPaper} binding(s) reference a paperId that no longer resolves to a Paper document -- left untouched.`);
}

console.log(`\n${APPLY ? `Updated ${fixed} binding(s).` : `Would update ${fixed} binding(s). Re-run with --apply to commit.`}`);

await ProductionBinding.db.close();
process.exit(0);
