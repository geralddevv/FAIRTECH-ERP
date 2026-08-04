import Advance from "../models/accounting/advance.js";
import AdvanceLog from "../models/accounting/AdvanceLog.js";
import Loan from "../models/accounting/Loan.js";
import LoanLog from "../models/accounting/LoanLog.js";

// ---------------------------------------------------------------------------
// Shared advance / loan ledger helpers.
//
// Both the Advance and Loan ledgers are running balances: every AdvanceLog /
// LoanLog row carries an openingBalance and closingBalance, and the master
// doc's currentBalance is just the closing of the last row. CREDIT adds to
// the balance (advance granted / loan taken), DEBIT subtracts (deducted at
// payroll). recompute() replays every row for one employee in chronological
// order, repairs each row's opening/closing, and syncs the master doc's
// currentBalance + status to match — the single source of truth for "what is
// this balance", used after a payroll delete removes the deduction rows and
// by scripts/rebuild-ledger-logs.js.
// ---------------------------------------------------------------------------

export function sortLedgerLogs(logs) {
  return [...logs].sort((a, b) => {
    const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    if (at !== bt) return at - bt;
    return String(a._id).localeCompare(String(b._id));
  });
}

async function recompute({ LogModel, MasterModel, employeeId, masterId }) {
  const logs = sortLedgerLogs(await LogModel.find({ employee: employeeId }).lean());

  const ops = [];
  let running = 0;

  for (const log of logs) {
    const openingBalance = running;
    const delta = log.type === "CREDIT" ? log.amount : -log.amount;
    const closingBalance = openingBalance + delta;

    const update = {};
    if (openingBalance !== log.openingBalance) update.openingBalance = openingBalance;
    if (closingBalance !== log.closingBalance) update.closingBalance = closingBalance;
    if (Object.keys(update).length) {
      ops.push({ updateOne: { filter: { _id: log._id }, update: { $set: update } } });
    }

    running = closingBalance;
  }

  if (ops.length) await LogModel.bulkWrite(ops);

  const balance = Number(running.toFixed(2));

  if (masterId) {
    const master = await MasterModel.findById(masterId);
    if (master) {
      master.currentBalance = Math.max(balance, 0);
      master.status = balance <= 0 ? "CLOSED" : "ACTIVE";
      await master.save();
    }
  }

  return balance;
}

export function recomputeAdvanceLedger(employeeId, advanceId) {
  return recompute({ LogModel: AdvanceLog, MasterModel: Advance, employeeId, masterId: advanceId });
}

export function recomputeLoanLedger(employeeId, loanId) {
  return recompute({ LogModel: LoanLog, MasterModel: Loan, employeeId, masterId: loanId });
}
