import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import mongoose from "mongoose";
import ProductionBinding from "../models/utilities/productionBinding.js";
import Die from "../models/utilities/die_model.js";

// ---------------------------------------------------------------------------
// Recompute the stored Production Binding calc values (the table shown on
// /fairtech/prodcalc/view) with the CURRENT formulas, for every binding.
//
// Mirrors views/utilities/prodCalc.ejs -> recalcProduction() EXACTLY:
//   Height comes from the DIE (dieHeight, mm), not the label.
//   Production Area   = (paperSize / dieAcross) * (dieHeight + dieRepeatGap) / D
//   Production Rate   = ratePerLabel / area
//   Sq Mtrs Rate      = productionRate * 1550
//   Per Label Cost    = (paperRate / 1550) * area          (needs paperRate)
//   Margin            = ratePerLabel - perLabelCost         (needs ratePerLabel + cost)
//   Margin / 1000     = margin * 1000
//   Actual (%)        = sqMtrsRate / paperRate              (needs paperRate)
// Values are stored to 5 decimals; a non-computable value is stored as "".
// The 645 basis uses the original field names; 625 uses the *625 names.
//
// A binding without enough inputs to compute an area (paper size, die across,
// die height, rate per label) is SKIPPED and left untouched -- never wiped.
//
// Dry-run by default. Pass --apply to write.
//   node scripts/backfill-prodbinding-calc.js          # preview
//   node scripts/backfill-prodbinding-calc.js --apply  # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

// Tolerant numeric read: strips inch marks / commas / spaces like the form's g().
function num(v) {
  const n = parseFloat(String(v ?? "").replace(/[^0-9.\-]/g, ""));
  return Number.isFinite(n) ? n : 0;
}
// Persisted representation: 5 decimals, or "" when not computable (matches raw()).
function raw(n) {
  return Number.isFinite(n) ? n.toFixed(5) : "";
}

function computeForDivisor(divisor, i) {
  const productionVal = ((i.paperSize / i.dieAcross) * (i.dieHeight + i.repeatGap)) / divisor;
  const productionRateVal = i.ratePerLabel / productionVal;
  const sqMtrsRateVal = productionRateVal * 1550;
  const perLabelProdCostVal = i.paperRate ? (i.paperRate / 1550) * productionVal : NaN;
  // Margin = per-label selling rate - per label prod cost. ratePerLabel is
  // Rate/1000 ÷ 1000; use it directly (perOneK is inconsistent on legacy rows).
  const marginVal =
    i.ratePerLabel && Number.isFinite(perLabelProdCostVal)
      ? i.ratePerLabel - perLabelProdCostVal
      : NaN;
  const marginPer1kVal = marginVal * 1000;
  const marginPercentageVal = i.paperRate ? sqMtrsRateVal / i.paperRate : NaN;
  return { productionVal, productionRateVal, sqMtrsRateVal, perLabelProdCostVal, marginVal, marginPer1kVal, marginPercentageVal };
}

// Map a computed row to its stored field names for a given basis suffix.
function fieldsFor(suffix, r) {
  return {
    [`prodArea${suffix}`]: raw(r.productionVal),
    [`productionRate${suffix}`]: raw(r.productionRateVal),
    [`prodSqMeter${suffix}`]: raw(r.sqMtrsRateVal),
    [`prodPerLabelCost${suffix}`]: raw(r.perLabelProdCostVal),
    [`prodMargin${suffix}`]: raw(r.marginVal),
    [`prodMargin1k${suffix}`]: raw(r.marginPer1kVal),
    [`prodActual${suffix}`]: raw(r.marginPercentageVal),
  };
}

await connectDB();

const bindings = await ProductionBinding.find({}).sort({ _id: -1 }).lean();
console.log(`Production bindings: ${bindings.length}`);
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

// Cache dies so repeated ids aren't re-queried.
const dieCache = new Map();
async function getDie(id) {
  if (!id) return null;
  const key = String(id);
  if (dieCache.has(key)) return dieCache.get(key);
  let die = null;
  if (mongoose.isValidObjectId(key)) die = await Die.findById(key).lean();
  dieCache.set(key, die);
  return die;
}

let updated = 0, skipped = 0, unchanged = 0;

for (const b of bindings) {
  const label = `${b.companyName || "?"} / ${b.userLocation || "?"} (_id ${b._id})`;
  const die = await getDie(b.dieId);

  const inputs = {
    paperSize: num(b.prodPaperSize),
    dieAcross: num(b.prodDieAcross),
    dieHeight: num(die?.dieHeight),
    repeatGap: num(die?.dieFlatrepGap),
    ratePerLabel: num(b.ratePerLabel),
    paperRate: num(b.prodPaperRate),
  };

  // Same readiness gate as the form -- no area without these four.
  const ready = inputs.paperSize && inputs.dieAcross && inputs.dieHeight && inputs.ratePerLabel;
  if (!ready) {
    const why = !die ? "die not found" : "missing paper size / die across / die height / rate per label";
    console.log(`SKIP     ${label}  [${why}]`);
    skipped++;
    continue;
  }

  const set = {
    ...fieldsFor("", computeForDivisor(645, inputs)),
    ...fieldsFor("625", computeForDivisor(625, inputs)),
  };

  // Diff against what's stored so we only report/write real changes.
  const changes = Object.entries(set).filter(([k, v]) => String(b[k] ?? "") !== String(v));
  if (!changes.length) {
    unchanged++;
    continue;
  }

  console.log(`UPDATE   ${label}`);
  for (const [k, v] of changes) console.log(`           ${k}: ${JSON.stringify(b[k] ?? "")} -> ${JSON.stringify(v)}`);
  if (APPLY) await ProductionBinding.updateOne({ _id: b._id }, { $set: set });
  updated++;
}

console.log(`\n--- Summary ---`);
console.log(`Updated:   ${updated}`);
console.log(`Unchanged: ${unchanged}`);
console.log(`Skipped:   ${skipped}`);
console.log(APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit.");

await mongoose.connection.close();
process.exit(0);
