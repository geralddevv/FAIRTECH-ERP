import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import ProductionBinding from "../models/utilities/productionBinding.js";
import Paper from "../models/inventory/paper.js";

// ---------------------------------------------------------------------------
// General-purpose backfill: link every ProductionBinding that's missing
// paperId (see models/utilities/productionBinding.js) to the Paper Master
// document its own vendor/code/family already names -- so its rate stays
// live with future Paper Master edits instead of frozen at whatever it was
// when the binding was saved. Older bindings, and any never re-saved through
// the Production Binding form since paperId was introduced, are all in this
// state; scripts/fix-prodbinding-papercode-a101-to-c011.js only ever handled
// one specific vendor+code.
//
// Three outcomes per binding, kept strictly separate so nothing gets
// silently "corrected" by a blanket pass across every client's data:
//
//   LINKED     vendor + code + family match exactly one active Paper Master
//              entry -- the safe case. Only paperId is set; prodPaperCode/
//              prodPaperFamily/prodPaperRate are already right, so nothing
//              else changes.
//   MISMATCH   vendor + code match exactly one Paper Master entry, but the
//              binding's stored family (or rate) disagrees with it -- same
//              shape as the A101 typo the previous script fixed, but this
//              pass does NOT guess which side is correct. Printed for
//              review, never written.
//   UNRESOLVED vendor + code don't match any Paper Master entry at all --
//              likely a typo, same as A101 was before anyone knew what the
//              correct code was. Printed for review, never written.
//
// Dry-run by default. Pass --apply to commit the LINKED cases only.
//
//   node scripts/backfill-prodbinding-paperid.js           # preview
//   node scripts/backfill-prodbinding-paperid.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

function escapeRegex(s) {
  return String(s || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

const bindings = await ProductionBinding.find({ paperId: { $exists: false } })
  .select("companyName prodVendorName prodPaperCode prodPaperFamily prodPaperRate")
  .lean();

console.log(`Bindings missing paperId: ${bindings.length}\n`);

let linked = 0;
const mismatches = [];
const unresolved = [];

for (const b of bindings) {
  const vendor = b.prodVendorName;
  const code = b.prodPaperCode;
  const family = b.prodPaperFamily;

  if (!vendor || !code) {
    unresolved.push({ ...b, reason: "no vendor/code stored on binding" });
    continue;
  }

  const exact = await Paper.findOne({
    vendorName: new RegExp(`^${escapeRegex(vendor)}$`, "i"),
    prodCode: new RegExp(`^${escapeRegex(code)}$`, "i"),
    family: new RegExp(`^${escapeRegex(family)}$`, "i"),
  }).lean();

  if (exact) {
    console.log(`LINKED   _id ${b._id} — ${b.companyName || "N/A"}`);
    console.log(`           ${vendor} / ${code} / ${family} -> paperId ${exact._id}`);
    if (APPLY) {
      await ProductionBinding.updateOne({ _id: b._id }, { $set: { paperId: exact._id } });
    }
    linked++;
    continue;
  }

  // vendor+code alone found exactly one paper, but family/rate disagree --
  // could be the same kind of typo A101 was, could be a deliberate distinct
  // spec. Report only; this pass never guesses which.
  const candidates = await Paper.find({
    vendorName: new RegExp(`^${escapeRegex(vendor)}$`, "i"),
    prodCode: new RegExp(`^${escapeRegex(code)}$`, "i"),
  }).lean();

  if (candidates.length === 1) {
    const p = candidates[0];
    console.log(`MISMATCH _id ${b._id} — ${b.companyName || "N/A"}`);
    console.log(`           binding: ${vendor} / ${code} / family "${family}", rate "${b.prodPaperRate}"`);
    console.log(`           master:  ${vendor} / ${code} / family "${p.family}", rate ${p.rate} (paperId ${p._id})`);
    mismatches.push(b);
  } else {
    console.log(`UNRESOLVED _id ${b._id} — ${b.companyName || "N/A"}`);
    console.log(`           ${vendor} / ${code} / ${family} -- ${candidates.length} Paper Master match(es), can't resolve automatically`);
    unresolved.push(b);
  }
}

console.log(`\n${APPLY ? `Linked ${linked} binding(s).` : `Would link ${linked} binding(s).`}`);
console.log(`${mismatches.length} mismatch(es) need review (see MISMATCH lines above) -- not written.`);
console.log(`${unresolved.length} unresolved (see UNRESOLVED lines above) -- not written.`);
if (!APPLY && linked) console.log("\nDry-run only. Re-run with --apply to commit the LINKED cases.");

await ProductionBinding.db.close();
process.exit(0);
