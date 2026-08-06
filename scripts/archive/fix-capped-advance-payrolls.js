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

// ---------------------------------------------------------------------------
// One-time correction for payrolls run while the advance deduction was
// capped at 50% of basic salary (routes/acccounting/payroll.js, since
// removed). Employees who had an advance balance bigger than that cap only
// had part of it deducted, leaving a balance stuck on their Advance record.
//
// For each employee below, this finds their most recent PAYROLL-sourced
// AdvanceLog debit, confirms it lines up with their current Payroll/
// PayrollLog snapshot (same month/year, same advance amount already
// deducted), then tops that same payroll up by the leftover balance:
//   payroll.advance        += leftover
//   payroll.totalDeduction += leftover
//   payroll.takeAway        = max(grossSalary - totalDeduction, 0)
//   advance.currentBalance  = 0, status = CLOSED
// and writes a new AdvanceLog DEBIT entry for the leftover so the ledger
// still shows two deductions adding up to the original advance amount,
// rather than silently editing the first one.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/fix-capped-advance-payrolls.js           # preview
//   node scripts/fix-capped-advance-payrolls.js --apply   # commit
// ---------------------------------------------------------------------------

const AFFECTED_EMPLOYEE_NAMES = [
  "KHURSHEED AFTAB SAYYAD",
  "INDRAJEET RAMROOP GUPTA",
  "SUNIL SHAH",
];

const APPLY = process.argv.includes("--apply");

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

for (const name of AFFECTED_EMPLOYEE_NAMES) {
  const emp = await Employee.findOne({ empName: new RegExp(`^\\s*${name}\\s*$`, "i") });
  if (!emp) {
    console.log(`SKIP     ${name}: employee not found\n`);
    continue;
  }

  const advance = await Advance.findOne({ employee: emp._id });
  if (!advance || advance.currentBalance <= 0) {
    console.log(`SKIP     ${emp.empName}: no outstanding advance balance\n`);
    continue;
  }

  const lastDebit = await AdvanceLog.findOne({
    employee: emp._id,
    advance: advance._id,
    type: "DEBIT",
    source: "PAYROLL",
  }).sort({ createdAt: -1 });

  if (!lastDebit) {
    console.log(`SKIP     ${emp.empName}: no PAYROLL-sourced debit found, nothing to top up\n`);
    continue;
  }

  const payroll = await Payroll.findOne({ employee: emp._id });
  const payrollLog = await PayrollLog.findOne({
    employee: emp._id,
    month: lastDebit.month,
    year: lastDebit.year,
    source: "SYSTEM",
  }).sort({ createdAt: -1 });

  if (!payroll || !payrollLog) {
    console.log(`SKIP     ${emp.empName}: couldn't find matching Payroll/PayrollLog for ${lastDebit.month}/${lastDebit.year}\n`);
    continue;
  }

  if (payroll.month !== lastDebit.month || payroll.year !== lastDebit.year) {
    console.log(`SKIP     ${emp.empName}: current payroll snapshot (${payroll.month}/${payroll.year}) is no longer the same month as the capped run (${lastDebit.month}/${lastDebit.year}) -- needs a manual look\n`);
    continue;
  }

  if (Math.round(payroll.advance * 100) !== Math.round(lastDebit.amount * 100)) {
    console.log(`SKIP     ${emp.empName}: payroll.advance (₹${payroll.advance}) doesn't match the capped debit (₹${lastDebit.amount}) -- needs a manual look\n`);
    continue;
  }

  const leftover = Number(advance.currentBalance.toFixed(2));
  const newAdvanceDeduction = Number((payroll.advance + leftover).toFixed(2));
  const newTotalDeduction = Number((payroll.totalDeduction + leftover).toFixed(2));
  const newTakeAway = Number(Math.max(payroll.grossSalary - newTotalDeduction, 0).toFixed(2));

  console.log(`FIX      ${emp.empName} (${lastDebit.month}/${lastDebit.year})`);
  console.log(`           advance:        ₹${payroll.advance} -> ₹${newAdvanceDeduction}  (+₹${leftover})`);
  console.log(`           totalDeduction: ₹${payroll.totalDeduction} -> ₹${newTotalDeduction}`);
  console.log(`           takeAway:       ₹${payroll.takeAway} -> ₹${newTakeAway}`);
  console.log(`           advance balance: ₹${advance.currentBalance} -> ₹0 (CLOSED)\n`);

  if (APPLY) {
    payroll.advance = newAdvanceDeduction;
    payroll.totalDeduction = newTotalDeduction;
    payroll.takeAway = newTakeAway;
    await payroll.save();

    payrollLog.advance = newAdvanceDeduction;
    payrollLog.totalDeduction = newTotalDeduction;
    payrollLog.takeAway = newTakeAway;
    await payrollLog.save();

    const openingBalance = advance.currentBalance;
    advance.currentBalance = 0;
    advance.status = "CLOSED";
    await advance.save();

    await AdvanceLog.create({
      employee: emp._id,
      advance: advance._id,
      openingBalance,
      amount: leftover,
      closingBalance: 0,
      type: "DEBIT",
      source: "PAYROLL",
      month: lastDebit.month,
      year: lastDebit.year,
    });
  }
}

console.log(`${APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit."}`);

await Employee.db.close();
process.exit(0);
