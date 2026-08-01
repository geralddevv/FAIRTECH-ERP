import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import Advance from "../models/accounting/advance.js";
import AdvanceLog from "../models/accounting/AdvanceLog.js";
import Loan from "../models/accounting/Loan.js";
import LoanLog from "../models/accounting/LoanLog.js";
import PayrollLog from "../models/accounting/PayrollLog.js";
import Employee from "../models/hr/employee_model.js";

// ---------------------------------------------------------------------------
// Cleans up "orphaned" PAYROLL-sourced Advance/Loan ledger entries.
//
// POST /fairtech/payroll/create deducts that month's EMI/advance and logs a
// DEBIT; DELETE /fairtech/payroll/logs/:id (delete a payroll record) reverses
// it with a matching CREDIT for the same employee+month+year, tied together
// only by (employee, month, year, source: "PAYROLL") -- there's no direct
// link back to the PayrollLog itself. So creating and then deleting the same
// month's payroll (e.g. while testing) leaves a DEBIT+CREDIT pair sitting in
// the ledger forever: net effect on the balance is zero, but they clutter
// the log view, and -- more importantly -- they still count as real steps in
// /fairtech/advance/logs/:id PATCH's balance-chain replay, so editing an
// earlier MANUAL entry down can spuriously fail ("This change would make the
// advance balance negative") against a DEBIT that no longer corresponds to
// any real payroll run.
//
// A PAYROLL log entry is "orphaned" when no PayrollLog exists for that same
// employee+month+year -- i.e. the payroll run that created it was later
// deleted. This script finds those, removes them, and replays the remaining
// chain (recomputing openingBalance/closingBalance in order) so the ledger
// stays internally consistent. Each employee's chain is verified to never go
// negative before anything is written.
//
// Dry-run by default -- pass --apply to commit.
//
//   node scripts/fix-orphaned-payroll-ledger-logs.js                # preview both ledgers
//   node scripts/fix-orphaned-payroll-ledger-logs.js --apply         # commit
//   node scripts/fix-orphaned-payroll-ledger-logs.js <employeeId>            # preview one employee
//   node scripts/fix-orphaned-payroll-ledger-logs.js <employeeId> --apply    # commit one employee
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const employeeFilter = args.find((a) => a !== "--apply" && mongoose.isValidObjectId(a));

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}${employeeFilter ? ` -- employee ${employeeFilter}` : " -- all employees"}\n`);

function sortLogs(logs) {
  return [...logs].sort((a, b) => {
    const aT = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bT = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (aT !== bT) return aT - bT;
    return String(a._id).localeCompare(String(b._id));
  });
}

// ledgerField: "advance" | "loan" -- the ref field name on the Log model
// pointing back to the balance document (Advance | Loan).
async function processLedger({ label, LogModel, BalanceModel, ledgerField }) {
  console.log(`=== ${label} ===`);

  const employeeIds = employeeFilter
    ? [employeeFilter]
    : (await LogModel.distinct("employee", { source: "PAYROLL" })).map(String);

  let totalOrphans = 0;
  let employeesTouched = 0;

  for (const employeeId of employeeIds) {
    const [logs, payrollLogs, emp] = await Promise.all([
      LogModel.find({ employee: employeeId }).lean(),
      PayrollLog.find({ employee: employeeId }, "month year").lean(),
      Employee.findById(employeeId).select("empName").lean(),
    ]);

    const livePeriods = new Set(payrollLogs.map((p) => `${p.month}|${p.year}`));
    const ordered = sortLogs(logs);

    const orphanIds = new Set(
      ordered
        .filter((l) => l.source === "PAYROLL" && !livePeriods.has(`${l.month}|${l.year}`))
        .map((l) => String(l._id)),
    );

    if (!orphanIds.size) continue;

    // Replay the full chain with the orphans excluded, recomputing
    // openingBalance/closingBalance for everything that remains.
    let running = 0;
    const updates = [];
    let negative = false;
    for (const log of ordered) {
      if (orphanIds.has(String(log._id))) continue;
      const opening = running;
      const delta = log.type === "CREDIT" ? log.amount : -log.amount;
      const closing = opening + delta;
      if (closing < 0) negative = true;
      if (opening !== log.openingBalance || closing !== log.closingBalance) {
        updates.push({ id: log._id, openingBalance: opening, closingBalance: closing });
      }
      running = closing;
    }

    const empLabel = emp?.empName || employeeId;
    console.log(`\n${empLabel} (${employeeId})`);
    console.log(`  Orphaned PAYROLL entries: ${orphanIds.size}`);
    ordered
      .filter((l) => orphanIds.has(String(l._id)))
      .forEach((l) => {
        console.log(`    ${l._id} ${l.type} Rs.${l.amount} (${l.month}/${l.year}) -- no PayrollLog for that period`);
      });

    if (negative) {
      console.log(`  SKIPPED -- replaying without these orphans would take the balance negative. Needs manual review.`);
      continue;
    }

    console.log(`  Recomputed running balance after removal: Rs.${running}`);
    if (updates.length) {
      console.log(`  Balance-chain rows to reindex: ${updates.length}`);
    }

    totalOrphans += orphanIds.size;
    employeesTouched += 1;

    if (APPLY) {
      const ops = updates.map((u) => ({
        updateOne: { filter: { _id: u.id }, update: { $set: { openingBalance: u.openingBalance, closingBalance: u.closingBalance } } },
      }));
      ops.push(...[...orphanIds].map((id) => ({ deleteOne: { filter: { _id: id } } })));
      if (ops.length) await LogModel.bulkWrite(ops);

      const balanceDoc = await BalanceModel.findOne({ employee: employeeId });
      if (balanceDoc) {
        balanceDoc.currentBalance = running;
        balanceDoc.status = running === 0 ? "CLOSED" : "ACTIVE";
        await balanceDoc.save();
      }
      console.log(`  APPLIED.`);
    }
  }

  console.log(`\n${label}: ${totalOrphans} orphaned entr${totalOrphans === 1 ? "y" : "ies"} across ${employeesTouched} employee(s).\n`);
}

await processLedger({ label: "Advance", LogModel: AdvanceLog, BalanceModel: Advance, ledgerField: "advance" });
await processLedger({ label: "Loan", LogModel: LoanLog, BalanceModel: Loan, ledgerField: "loan" });

if (!APPLY) console.log("Dry-run only. Re-run with --apply to commit.");

await mongoose.disconnect();
process.exit(0);
