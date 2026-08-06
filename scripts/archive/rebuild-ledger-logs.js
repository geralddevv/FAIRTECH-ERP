import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../../config/db.js";
import Employee from "../../models/hr/employee_model.js";
import Payroll from "../../models/accounting/Payroll.js";
import PayrollLog from "../../models/accounting/PayrollLog.js";
import Advance from "../../models/accounting/advance.js";
import AdvanceLog from "../../models/accounting/AdvanceLog.js";
import Loan from "../../models/accounting/Loan.js";
import LoanLog from "../../models/accounting/LoanLog.js";
import { sortLedgerLogs, recomputeAdvanceLedger, recomputeLoanLedger } from "../../utils/ledger.js";

// ---------------------------------------------------------------------------
// Canonicalise the advance & loan ledgers, removing accumulated garbage.
//
// Over time the old payroll-delete flow "reversed" a deduction by ADDING a
// matching CREDIT instead of removing the DEBIT, so every create/delete cycle
// left a DEBIT/CREDIT pair behind, and deleted payrolls left rows with no
// PayrollLog at all (orphans). A capped-then-topped-up advance also produced
// two DEBIT rows for one month.
//
// This rebuild reduces each ledger to its meaningful rows WITHOUT changing any
// master balance:
//   * MANUAL rows (real grants / loans / manual edits) are kept as-is.
//   * PAYROLL rows are grouped per month/year and collapsed to a single net
//     row (one DEBIT for the net amount deducted that month, or one CREDIT if
//     net positive). The kept row is the earliest of the group, so its place
//     in the timeline is preserved.
//   * A PAYROLL group that nets to zero (a reverse pair) is dropped entirely.
//   * A PAYROLL group whose month/year has no matching PayrollLog (an orphan
//     from a deleted payroll) is dropped entirely.
// Opening/closing balances and the master currentBalance/status are then
// recomputed from the surviving rows. Because collapsing preserves each
// group's net, every master balance is left unchanged (the script prints a
// before/after check so you can confirm).
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/rebuild-ledger-logs.js           # preview
//   node scripts/rebuild-ledger-logs.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

/* PayrollLogs grouped per employee (the authority on which periods are real) */
const payrollLogs = await PayrollLog.find({}, "employee month year createdAt").lean();
const payrollsByEmp = new Map();
for (const p of payrollLogs) {
  const k = String(p.employee);
  if (!payrollsByEmp.has(k)) payrollsByEmp.set(k, []);
  payrollsByEmp.get(k).push(p);
}

const round = (n) => Number(n.toFixed(2));
const REPOINT_WINDOW_MS = 120000; // a ledger row created within 2 min of a payroll belongs to it

/*
 * Decide which real payroll period a PAYROLL ledger row belongs to. Normally
 * that's its own month/year. But a payroll whose month was edited after the
 * fact left its ledger rows stranded on the old period (they were stamped at
 * create time and never moved) -- for those, fall back to the payroll created
 * at almost the same instant as the row. Returns "month|year", or null when
 * the row matches no surviving payroll (an orphan from a deleted one).
 */
function resolvePeriod(row, payrolls) {
  const own = payrolls.find((p) => p.month === row.month && p.year === row.year);
  if (own) return `${own.month}|${own.year}`;

  let best = null;
  let bestDiff = Infinity;
  for (const p of payrolls) {
    const diff = Math.abs(new Date(p.createdAt).getTime() - new Date(row.createdAt).getTime());
    if (diff < bestDiff) {
      bestDiff = diff;
      best = p;
    }
  }
  if (best && bestDiff <= REPOINT_WINDOW_MS) return `${best.month}|${best.year}`;
  return null;
}

/*
 * Plan the canonical shape of one employee's ledger. Returns the row _ids to
 * delete and the edits to apply (a kept row repurposed to the group net, and
 * re-pointed onto its real period). Pure -- makes no writes.
 */
function planLedger(logs, refField, payrolls) {
  const sorted = sortLedgerLogs(logs);
  const masterId = sorted.length ? sorted[0][refField] : null;

  const deleteIds = [];
  const edits = []; // { _id, set: { type?, amount?, month?, year? } }
  const groups = new Map(); // resolved "month|year" -> rows[]

  for (const log of sorted) {
    if (log.source === "MANUAL") continue; // real user actions, always kept

    const period = resolvePeriod(log, payrolls);
    if (!period) {
      deleteIds.push(log._id); // orphan of a deleted payroll
      continue;
    }
    if (!groups.has(period)) groups.set(period, []);
    groups.get(period).push(log);
  }

  for (const [period, rows] of groups) {
    const [month, year] = period.split("|").map(Number);
    const net = round(
      rows.reduce((s, r) => s + (r.type === "CREDIT" ? r.amount : -r.amount), 0),
    );

    if (net === 0) {
      rows.forEach((r) => deleteIds.push(r._id)); // reverse pair, nets to nothing
      continue;
    }

    // collapse: keep the earliest row as the net for this period, delete the rest
    const [keep, ...rest] = rows;
    rest.forEach((r) => deleteIds.push(r._id));

    const type = net < 0 ? "DEBIT" : "CREDIT";
    const amount = Math.abs(net);
    const set = {};
    if (keep.type !== type) set.type = type;
    if (round(keep.amount) !== amount) set.amount = amount;
    if (keep.month !== month) set.month = month;
    if (keep.year !== year) set.year = year;
    if (Object.keys(set).length) edits.push({ _id: keep._id, set });
  }

  return { masterId, deleteIds, edits };
}

async function processLedger({ label, LogModel, MasterModel, recomputeFn, refField }) {
  console.log(`\n===== ${label} =====`);
  const employeeIds = await LogModel.distinct("employee");
  let touched = 0;

  for (const employeeId of employeeIds) {
    const logs = await LogModel.find({ employee: employeeId }).lean();
    if (!logs.length) continue;

    const payrolls = payrollsByEmp.get(String(employeeId)) || [];
    const { masterId, deleteIds, edits } = planLedger(logs, refField, payrolls);
    if (!deleteIds.length && !edits.length) continue;

    touched++;
    const emp = await Employee.findById(employeeId).select("empName").lean();
    const master = masterId ? await MasterModel.findById(masterId).lean() : null;
    const before = master ? round(master.currentBalance) : 0;

    console.log(`\n  ${emp?.empName?.trim() || employeeId}`);
    console.log(`    rows: ${logs.length} | delete: ${deleteIds.length} | edits: ${edits.length}`);
    for (const e of edits) {
      const parts = Object.entries(e.set).map(([k, v]) => `${k}=${v}`).join(", ");
      console.log(`      keep row ${e._id} -> ${parts}`);
    }

    // simulate the resulting balance from the surviving rows (edits applied)
    const editMap = new Map(edits.map((e) => [String(e._id), e.set]));
    const dropped = new Set(deleteIds.map(String));
    let running = 0;
    for (const l of sortLedgerLogs(logs)) {
      if (dropped.has(String(l._id))) continue;
      const set = editMap.get(String(l._id)) || {};
      const type = set.type ?? l.type;
      const amount = set.amount ?? l.amount;
      running += type === "CREDIT" ? amount : -amount;
    }
    running = round(running);
    const safe = running === before;

    if (!safe) {
      console.log(`    balance: ₹${before} -> ₹${running}  [WOULD CHANGE -- SKIPPED for safety]`);
      continue;
    }

    if (APPLY) {
      if (edits.length) {
        await LogModel.bulkWrite(
          edits.map((e) => ({ updateOne: { filter: { _id: e._id }, update: { $set: e.set } } })),
        );
      }
      if (deleteIds.length) {
        await LogModel.deleteMany({ _id: { $in: deleteIds } });
      }
      const after = round(await recomputeFn(employeeId, masterId));
      console.log(`    balance: ₹${before} -> ₹${after}  [${after === before ? "ok" : "BALANCE CHANGED!"}]`);
    } else {
      console.log(`    balance: ₹${before} (unchanged)  [ok]`);
    }
  }

  if (!touched) console.log("  nothing to clean.");
}

await processLedger({
  label: "ADVANCE LEDGER",
  LogModel: AdvanceLog,
  MasterModel: Advance,
  recomputeFn: recomputeAdvanceLedger,
  refField: "advance",
});

await processLedger({
  label: "LOAN LEDGER",
  LogModel: LoanLog,
  MasterModel: Loan,
  recomputeFn: recomputeLoanLedger,
  refField: "loan",
});

console.log(`\n${APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit."}`);

await Employee.db.close();
process.exit(0);
