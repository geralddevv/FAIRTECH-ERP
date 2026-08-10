import { fileURLToPath } from "url";
import path from "path";
import fs from "fs";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import ProductionBinding from "../models/utilities/productionBinding.js";
import Label from "../models/inventory/labels.js";
import Paper from "../models/inventory/paper.js";
import "../models/users/username.js"; // registers Username model for populate

// ---------------------------------------------------------------------------
// Report: where /fairtech/prodcalc/view's Margin % actually comes from.
//
// READ-ONLY. This script never writes to the database -- there is no --apply.
//
// Margin % (`prodActual`) on the Production Binding view is NOT the snapshot
// taken when the binding was saved. The route recomputes it on every page load
// from two live sources (routes/fairdesk_route.js, withLiveRate +
// withLiveLabelRate):
//
//   Paper.rate            <- via binding.paperId          (the material rate)
//   Label.ratePerLabel    <- via binding.labelProductId   (the selling rate)
//
// and Label.ratePerLabel is itself "Our Amount Per 1000" / 1000 -- the rate
// NET of sales commission, i.e. (ratePerK - commissionPerK) / 1000, computed by
// /fairtech/form/labels and stored by models/inventory/labels.js. It is NOT the
// gross ratePerK the client is billed. The formulas, per area divisor (645 and
// its 625-basis sibling):
//
//   productionRate = ratePerLabel / prodArea
//   sqMtrsRate     = productionRate * 1550
//   Margin %       = sqMtrsRate / paperRate          -> prodActual
//   Margin         = ratePerLabel - (paperRate / 1550) * prodArea
//
// A binding only gets that live recompute if its labelProductId still resolves
// to a Label carrying a numeric ratePerLabel. When it doesn't -- no id, a
// malformed id, or the Label has since been deleted -- withLiveLabelRate
// returns the row untouched and the page falls back to the FROZEN snapshot
// written at bind/last-edit time. Those rows are the point of this report:
// their Margin % can no longer follow a change to Our Amount Per 1000, and no
// backfill can repair them, because the rate they would be recomputed from no
// longer exists.
//
// Three sections are printed:
//
//   1. SUMMARY        -- how many bindings are live vs frozen, and why.
//   2. FROZEN         -- every binding stuck on its snapshot, with the reason.
//   3. DRIFT          -- live bindings whose stored snapshot disagrees with the
//                        live recompute by more than --tolerance. This is
//                        expected and harmless (the page shows the live figure,
//                        which is correct); it just measures how stale the
//                        stored copy has gone since the label or paper rate
//                        last moved.
//
// A fourth check runs silently and only reports on failure: every Label is
// tested for ratePerLabel == (ratePerK - commissionPerK) / 1000, catching any
// label whose stored per-label rate has drifted off its own Our Amount Per
// 1000 -- which would feed a wrong Margin % into every binding built from it.
//
//   node scripts/report-prodcalc-margin-source.js              # full report
//   node scripts/report-prodcalc-margin-source.js --frozen     # frozen rows only
//   node scripts/report-prodcalc-margin-source.js --tolerance=0.01
//   node scripts/report-prodcalc-margin-source.js --csv=out.csv
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const FROZEN_ONLY = args.includes("--frozen");
const csvArg = args.find((a) => a.startsWith("--csv="));
const CSV_PATH = csvArg ? csvArg.slice("--csv=".length) : null;
const tolArg = args.find((a) => a.startsWith("--tolerance="));
// Snapshots are stored to 5dp and the recompute divides by prodArea, which
// amplifies that rounding in proportion to the margin -- a 12.5% row shows a
// ~1e-4 delta from rounding alone. 0.001 is below anything that could shift a
// row's colour band but above every rounding artefact seen in the data.
const TOLERANCE = tolArg && Number.isFinite(Number(tolArg.slice("--tolerance=".length)))
  ? Number(tolArg.slice("--tolerance=".length))
  : 0.001;

// Blank/absent must read as NaN, not 0: these fields are stored as strings and
// Number("") === 0, which would report an uncomputed Margin % as a real 0.
const num = (v) => {
  if (v === null || v === undefined) return NaN;
  if (typeof v === "string" && v.trim() === "") return NaN;
  const n = Number(v);
  return Number.isFinite(n) ? n : NaN;
};
const fmt = (n, dec = 5) => (Number.isFinite(n) ? n.toFixed(dec) : "—");

await connectDB();

const bindings = await ProductionBinding.find({})
  .populate({ path: "userId", model: "Username", select: "userName clientName" })
  .sort({ _id: -1 })
  .lean();

// --- live lookups, exactly as the route builds them -------------------------
const paperIds = bindings.map((b) => b.paperId).filter((id) => id && mongoose.isValidObjectId(String(id)));
const papers = paperIds.length ? await Paper.find({ _id: { $in: paperIds } }).select("rate paperProductId prodCode").lean() : [];
const paperById = new Map(papers.map((p) => [String(p._id), p]));

const labelIds = bindings.map((b) => b.labelProductId).filter((id) => id && mongoose.isValidObjectId(String(id)));
const labels = labelIds.length
  ? await Label.find({ _id: { $in: labelIds } }).select("ratePerLabel ratePerK commissionPerK labelFamily jobName").lean()
  : [];
const labelById = new Map(labels.map((l) => [String(l._id), l]));

// --- classify every binding -------------------------------------------------
// withLiveLabelRate bails in two stages, and BOTH leave Margin % on its stored
// snapshot: the outer guard skips a binding whose label doesn't resolve, and
// recompute() then returns {} unless prodArea is a non-zero number, and omits
// prodActual unless the paper rate is a non-zero number too. So a binding with
// a perfectly good label can still be frozen for want of an area or a rate.
const REASONS = {
  NO_ID: "no labelProductId on the binding",
  BAD_ID: "labelProductId is not a valid ObjectId",
  DELETED: "the Label it points at has been deleted",
  NO_RATE: "the Label has no numeric ratePerLabel",
  NO_AREA: "the binding has no usable prodArea to divide by",
  NO_PAPER_RATE: "no paper rate (paperId unresolved and prodPaperRate blank)",
};

const live = [];
const frozen = [];
const outsourced = [];

for (const b of bindings) {
  const id = b.labelProductId;
  const row = {
    _id: String(b._id),
    client: b.userId?.clientName || b.companyName || "",
    user: b.userId?.userName || b.userName || "",
    label: b.labelProductName || b.prodJobName || b.jobName || "",
    labelId: id ? String(id) : "",
    paperCode: b.prodPaperCode || "",
    storedActual: num(b.prodActual),
  };

  // An outsourced binding is bought in as finished labels, so it has no paper
  // behind it at all -- /fairtech/form/prodcalc drops the required on Paper
  // Code and Paper size (see CLAUDE.md, "Outsourced labels"), and it saves with
  // no prodArea and no paper rate. There is therefore no in-house margin to
  // compute, by design. These are NOT frozen rows and must never be reported as
  // needing a resave: they'd fail the prodArea/paper-rate tests below purely
  // because those figures don't apply to them.
  if (b.isOutsource) { outsourced.push(row); continue; }

  if (!id) { frozen.push({ ...row, reason: REASONS.NO_ID }); continue; }
  if (!mongoose.isValidObjectId(String(id))) { frozen.push({ ...row, reason: REASONS.BAD_ID }); continue; }
  const l = labelById.get(String(id));
  if (!l) { frozen.push({ ...row, reason: REASONS.DELETED }); continue; }
  const ratePerLabel = num(l.ratePerLabel);
  if (!Number.isFinite(ratePerLabel)) { frozen.push({ ...row, reason: REASONS.NO_RATE }); continue; }

  // Live paper rate first (withLiveRate runs before withLiveLabelRate), then
  // the same recompute the route performs for the 645 basis.
  const paper = b.paperId ? paperById.get(String(b.paperId)) : undefined;
  const paperRate = num(paper?.rate != null ? paper.rate : b.prodPaperRate);
  const prodArea = num(b.prodArea);

  const rowRates = { ...row, ourAmountPerK: ratePerLabel * 1000, paperRate, prodArea };
  if (!Number.isFinite(prodArea) || !prodArea) { frozen.push({ ...rowRates, reason: REASONS.NO_AREA }); continue; }
  if (!Number.isFinite(paperRate) || !paperRate) { frozen.push({ ...rowRates, reason: REASONS.NO_PAPER_RATE }); continue; }

  const liveActual = ((ratePerLabel / prodArea) * 1550) / paperRate;

  live.push({
    ...row,
    ourAmountPerK: ratePerLabel * 1000, // reconstructs Our Amount Per 1000
    ratePerK: num(l.ratePerK),
    commissionPerK: num(l.commissionPerK || 0),
    paperRate,
    prodArea,
    liveActual,
    delta: Number.isFinite(liveActual) && Number.isFinite(row.storedActual) ? liveActual - row.storedActual : NaN,
    paperLive: !!paper,
  });
}

// --- 1. summary -------------------------------------------------------------
const byReason = {};
for (const f of frozen) byReason[f.reason] = (byReason[f.reason] || 0) + 1;

console.log("");
console.log("=".repeat(78));
console.log("  MARGIN % SOURCE REPORT  --  /fairtech/prodcalc/view");
console.log("=".repeat(78));
console.log("");
console.log("  Margin % = (Our Amount Per 1000 / 1000 / prodArea * 1550) / paper rate");
console.log("  Our Amount Per 1000 = Rate Per 1000 - commission  (net, NOT the gross rate)");
console.log("");
console.log(`  Production Bindings total      : ${bindings.length}`);
console.log(`    live from Our Amount Per 1000: ${live.length}`);
console.log(`    frozen on stored snapshot    : ${frozen.length}`);
for (const [reason, count] of Object.entries(byReason)) {
  console.log(`       - ${reason}: ${count}`);
}
console.log(`    outsourced, no margin by design: ${outsourced.length}`);
if (outsourced.length) {
  for (const o of outsourced) {
    console.log(`       - ${o._id}  ${o.client || "—"} / ${o.label || "—"}  (bought in finished; no paper, no margin)`);
  }
}
console.log("");

// --- silent integrity check on the Labels themselves ------------------------
const allLabels = await Label.find({}).select("ratePerLabel ratePerK commissionPerK").lean();
const labelMismatches = [];
for (const l of allLabels) {
  const rk = num(l.ratePerK), cm = num(l.commissionPerK || 0), stored = num(l.ratePerLabel);
  if (!Number.isFinite(rk) || !Number.isFinite(stored)) continue;
  const expected = Math.max(0, rk - (Number.isFinite(cm) ? cm : 0)) / 1000;
  if (Math.abs(expected - stored) > 1e-9) {
    labelMismatches.push({ labelId: String(l._id), ratePerK: l.ratePerK, commissionPerK: l.commissionPerK, stored: l.ratePerLabel, expected: fmt(expected, 6) });
  }
}
if (labelMismatches.length) {
  console.log(`  !! ${labelMismatches.length} of ${allLabels.length} Labels have ratePerLabel out of step with`);
  console.log(`     their own Our Amount Per 1000 -- every binding on them reads a wrong Margin %:`);
  console.table(labelMismatches.slice(0, 25));
  console.log("");
} else {
  console.log(`  Label rate integrity          : OK (${allLabels.length}/${allLabels.length} match Our Amount Per 1000)`);
  console.log("");
}

// --- 2. frozen bindings -----------------------------------------------------
console.log("-".repeat(78));
console.log(`  FROZEN BINDINGS (${frozen.length}) -- Margin % can no longer follow Our Amount`);
console.log("-".repeat(78));
if (!frozen.length) {
  console.log("  None. Every binding recomputes live.");
} else {
  for (const f of frozen) {
    console.log(`  ${f._id}  stored Margin % ${fmt(f.storedActual)}`);
    console.log(`     client ${f.client || "—"} / user ${f.user || "—"} / label ${f.label || "—"}`);
    console.log(`     reason: ${f.reason}${f.labelId ? `  (labelProductId ${f.labelId})` : ""}`);
    if (Number.isFinite(f.ourAmountPerK)) {
      console.log(`     ourAmt/1000 ${fmt(f.ourAmountPerK, 2)}  paperRate ${fmt(f.paperRate, 2)}  prodArea ${fmt(f.prodArea)}`);
    }
    console.log("");
  }
  // The two fixable reasons are the ones where the label is still alive and
  // only the binding's own numbers are missing -- reopening and resaving the
  // Production Binding fills them in. A dead label can't be recomputed at all.
  const fixable = frozen.filter((f) => f.reason === REASONS.NO_AREA || f.reason === REASONS.NO_PAPER_RATE).length;
  if (fixable) console.log(`  ${fixable} fixable: reopen the binding on /fairtech/form/prodcalc and resave to fill in the missing area/paper rate.`);
  if (frozen.length - fixable) {
    console.log(`  ${frozen.length - fixable} NOT backfillable -- the label they would recompute from is gone.`);
    console.log(`  Either delete the binding or rebuild it against a live label.`);
  }
}
console.log("");

// --- 3. drift ---------------------------------------------------------------
if (!FROZEN_ONLY) {
  const drifted = live
    .filter((r) => Number.isFinite(r.delta) && Math.abs(r.delta) > TOLERANCE)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));

  console.log("-".repeat(78));
  console.log(`  SNAPSHOT DRIFT (${drifted.length} of ${live.length}) -- tolerance ${TOLERANCE}`);
  console.log("-".repeat(78));
  console.log("  The page shows the LIVE column, which is correct. This only measures");
  console.log("  how far each stored snapshot has fallen behind since the rates moved.");
  console.log("");
  console.log("  implPaperRate = the paper rate the stored snapshot implies was in force when");
  console.log("  the binding was saved: paperRate * live / stored. Both figures share the same");
  console.log("  ratePerLabel and prodArea, so if that lands on a believable rate the drift is");
  console.log("  a paper-rate move and nothing else. Paper Master only ratchets UP automatically");
  console.log("  (bumpPaperRate), so implPaperRate ABOVE the live rate means someone edited the");
  console.log("  master down by hand -- the only way that number can fall.");
  console.log("");
  if (!drifted.length) {
    console.log("  None. Every stored snapshot still agrees with its live recompute.");
  } else {
    console.table(
      drifted.slice(0, 40).map((r) => ({
        binding: r._id,
        client: (r.client || "").slice(0, 18),
        label: (r.label || "").slice(0, 18),
        "ourAmt/1000": fmt(r.ourAmountPerK, 2),
        paperRate: fmt(r.paperRate, 2),
        implPaperRate: r.storedActual ? fmt((r.paperRate * r.liveActual) / r.storedActual, 2) : "—",
        stored: fmt(r.storedActual),
        live: fmt(r.liveActual),
        delta: fmt(r.delta),
      })),
    );
    if (drifted.length > 40) console.log(`  ... and ${drifted.length - 40} more (use --csv= for the full list).`);
  }
  console.log("");
}

// --- optional CSV -----------------------------------------------------------
if (CSV_PATH) {
  const esc = (v) => {
    const s = v === undefined || v === null || (typeof v === "number" && !Number.isFinite(v)) ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = [
    "bindingId", "status", "reason", "client", "user", "label", "labelId", "paperCode",
    "ratePerK_gross", "commissionPerK", "ourAmountPerK_net", "paperRate", "prodArea",
    "storedMarginPct", "liveMarginPct", "delta",
  ];
  const lines = [header.join(",")];
  for (const r of live) {
    lines.push([
      r._id, "LIVE", "", r.client, r.user, r.label, r.labelId, r.paperCode,
      fmt(r.ratePerK, 2), fmt(r.commissionPerK, 2), fmt(r.ourAmountPerK, 2), fmt(r.paperRate, 2), fmt(r.prodArea),
      fmt(r.storedActual), fmt(r.liveActual), fmt(r.delta),
    ].map(esc).join(","));
  }
  for (const r of frozen) {
    lines.push([
      r._id, "FROZEN", r.reason, r.client, r.user, r.label, r.labelId, r.paperCode,
      "", "", fmt(r.ourAmountPerK, 2), fmt(r.paperRate, 2), fmt(r.prodArea),
      fmt(r.storedActual), "", "",
    ].map(esc).join(","));
  }
  for (const r of outsourced) {
    lines.push([
      r._id, "OUTSOURCED", "bought in finished; no paper, no in-house margin",
      r.client, r.user, r.label, r.labelId, r.paperCode,
      "", "", "", "", "", "", "", "",
    ].map(esc).join(","));
  }
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
