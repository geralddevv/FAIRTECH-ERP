import express from "express";
import Employee from "../../models/hr/employee_model.js";
import Payroll from "../../models/accounting/Payroll.js";
import PayrollLog from "../../models/accounting/PayrollLog.js";
import Loan from "../../models/accounting/Loan.js";
import LoanLog from "../../models/accounting/LoanLog.js";
import Advance from "../../models/accounting/advance.js";
import AdvanceLog from "../../models/accounting/AdvanceLog.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";
import { recomputeAdvanceLedger, recomputeLoanLedger } from "../../utils/ledger.js";

const router = express.Router();

/* SHOW PAYROLL FORM */
router.get("/create", async (req, res) => {
  const employees = await Employee.find({ isActive: true }).sort({ empName: 1 });
  const existingPayrolls = await PayrollLog.find({}, "employee month year").lean();

  res.render("accounting/payroll", {
    employees,
    existingPayrolls: existingPayrolls.map((p) => ({
      employee: String(p.employee),
      month: p.month,
      year: p.year,
    })),
    editMode: false,
    editData: null,
    CSS: false,
    JS: false,
    title: "Payroll",
    navigator: "payroll",
    notification: req.flash("notification"),
    error: req.flash("error"),
  });
});

/* SHOW PAYROLL FORM PREFILLED FOR EDIT (same form as create) */
router.get("/edit/:id", async (req, res) => {
  try {
    const log = await PayrollLog.findById(req.params.id).lean();
    if (!log) {
      req.flash("error", "Payroll record not found.");
      return res.redirect("/fairtech/payroll/view");
    }

    const [emp, employees, existingPayrolls, loan, loanRows] = await Promise.all([
      Employee.findById(log.employee).lean(),
      Employee.find({ isActive: true }).sort({ empName: 1 }),
      PayrollLog.find({}, "employee month year").lean(),
      Loan.findOne({ employee: log.employee }).lean(),
      LoanLog.find({ employee: log.employee, month: log.month, year: log.year, source: "PAYROLL" }).lean(),
    ]);

    // Loan EMI actually deducted for this run (net of the ledger rows). The
    // advance stays LOCKED in the edit form, but the EMI is editable — so we
    // also surface this run's own opening balance (the balance just before
    // this deduction, taken from the ledger row) as the form's Opening
    // Balance, letting the closing preview react to a changed EMI.
    const loanEmi = loanRows.reduce((s, r) => s + (r.type === "DEBIT" ? r.amount : -r.amount), 0);
    const loanDebitRow = loanRows.find((r) => r.type === "DEBIT");
    const loanRunOpening = loanDebitRow ? loanDebitRow.openingBalance ?? 0 : loan?.currentBalance ?? 0;

    // The per-run allowance/PT split isn't stored (only the totals are), so
    // reconstruct it from the stored totals: OT amount is faithfully derived
    // from the stored OT hours, and whatever additions/deductions remain are
    // folded into Travelling / PT. This guarantees that re-saving the form
    // without changing anything reproduces the stored totals exactly (see the
    // matching no-bonus formula in POST /edit).
    const baseSalary = log.baseSalary ?? emp?.basicSalary ?? 0;
    const totalDaysInMonth = new Date(log.year, log.month, 0).getDate();
    const perDay = totalDaysInMonth ? baseSalary / totalDaysInMonth : 0;
    const absentAmount = (log.absentDays || 0) * perDay;
    const otAmount = (baseSalary / 30 / 9) * (log.otHours || 0);
    const houseRent = emp?.houseRent || 0;
    const travellingRecon = Math.max(Number(((log.totalAdditions || 0) - otAmount - houseRent).toFixed(2)), 0);
    const ptRecon = Math.max(Number(((log.totalDeduction || 0) - absentAmount - (log.advance || 0) - loanEmi).toFixed(2)), 0);

    const editData = {
      id: String(log._id),
      employeeId: String(log.employee),
      empId: emp?.empId || "",
      basicSalary: baseSalary,
      month: log.month,
      year: log.year,
      absentDays: log.absentDays ?? 0,
      otHours: log.otHours ?? 0,
      incentive: log.incentive ?? 0,
      advance: log.advance ?? 0,
      loanEmi,
      loanCurrentBalance: loan?.currentBalance ?? 0,
      loanRunOpening,
      profile: {
        pt: ptRecon,
        tds: emp?.empTDS || 0,
        lic: emp?.empLIC || 0,
        medical: emp?.empMedical || 0,
        nsic: emp?.empNSIC || 0,
        esic: emp?.empESIC || 0,
        pf: emp?.empPF || 0,
        houseRent,
        travelling: travellingRecon,
        railwayPass: 0,
      },
    };

    res.render("accounting/payroll", {
      employees,
      existingPayrolls: existingPayrolls.map((p) => ({
        employee: String(p.employee),
        month: p.month,
        year: p.year,
      })),
      editMode: true,
      editData,
      CSS: false,
      JS: false,
      title: "Edit Payroll",
      navigator: "payroll",
      notification: req.flash("notification"),
      error: req.flash("error"),
    });
  } catch (err) {
    console.error("PAYROLL EDIT FORM ERROR:", err);
    req.flash("error", "Failed to open payroll for editing.");
    res.redirect("/fairtech/payroll/view");
  }
});

/* SAVE EDITS FROM THE PREFILLED FORM (money-safe: advance/loan are not re-deducted) */
router.post("/edit/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const log = await PayrollLog.findById(req.params.id);
    if (!log) {
      req.flash("error", "Payroll record not found.");
      return res.redirect("/fairtech/payroll/view");
    }
    const emp = await Employee.findById(log.employee);
    if (!emp) {
      req.flash("error", "Employee not found.");
      return res.redirect("/fairtech/payroll/view");
    }

    const baseSalary = Number(log.baseSalary) || Number(emp.basicSalary) || 0;

    const month = Number(req.body.month ?? log.month);
    const year = Number(req.body.year ?? log.year);
    if (!Number.isInteger(month) || month < 1 || month > 12 || !Number.isInteger(year) || year < 2000 || year > 2100) {
      req.flash("error", "Please enter a valid month and year.");
      return res.redirect("back");
    }
    if (month !== log.month || year !== log.year) {
      const dup = await PayrollLog.findOne({ _id: { $ne: log._id }, employee: log.employee, month, year }).lean();
      if (dup) {
        req.flash("error", "Payroll already exists for this employee and month.");
        return res.redirect("back");
      }
    }

    const absentDays = Number(req.body.absentDays || 0);
    const otHours = Number(req.body.othrs || 0);
    const incentive = Number(req.body.incentive || 0);
    const empPT = Number(req.body.empPT ?? emp.empPT ?? 0);
    const houseRent = Number(req.body.houseRent || 0);
    const travelling = Number(req.body.travelling || 0);
    const railwayPass = Number(req.body.railwayPass || 0);
    const otAmount = Number(req.body.empOtAmount || 0);

    // ADVANCE (LOCKED): reuse exactly what this run already deducted — an edit
    // never re-runs the advance deduction, so that balance doesn't move.
    const advanceDeduction = Number(log.advance) || 0;

    // LOAN EMI (EDITABLE): apply the amount entered on the form to this run's
    // loan-ledger row, then replay the whole ledger so every row's
    // opening/closing and the loan master's balance/status stay consistent.
    // The row is still under the run's *old* period here (log.month/year are
    // reassigned further down), so the later period-move carries it along.
    const loanRows = await LoanLog.find({
      employee: log.employee,
      month: log.month,
      year: log.year,
      source: "PAYROLL",
    }).sort({ createdAt: 1 });
    const oldEmi = loanRows.reduce((s, r) => s + (r.type === "DEBIT" ? r.amount : -r.amount), 0);

    let emiAmount = Math.max(Number(req.body.emi || 0), 0);
    if (emiAmount !== oldEmi) {
      const loan = await Loan.findOne({ employee: log.employee });
      const debitRow = loanRows.find((r) => r.type === "DEBIT");
      if (debitRow) {
        // Can't deduct more than was owed at the start of this run.
        emiAmount = Math.min(emiAmount, Number(debitRow.openingBalance) || 0);
        if (emiAmount > 0) {
          debitRow.amount = emiAmount;
          await debitRow.save();
        } else {
          await LoanLog.deleteOne({ _id: debitRow._id });
        }
        if (loan) await recomputeLoanLedger(log.employee, loan._id);
      } else if (loan && emiAmount > 0) {
        // This run carried no EMI before — open a deduction against the loan.
        emiAmount = Math.min(emiAmount, Number(loan.currentBalance) || 0);
        if (emiAmount > 0) {
          await LoanLog.create({
            employee: log.employee,
            loan: loan._id,
            openingBalance: 0,
            amount: emiAmount,
            closingBalance: 0,
            type: "DEBIT",
            source: "PAYROLL",
            month: log.month,
            year: log.year,
          });
          await recomputeLoanLedger(log.employee, loan._id);
        } else {
          emiAmount = oldEmi;
        }
      } else {
        // No loan to attach a deduction to — keep the run unchanged.
        emiAmount = oldEmi;
      }
    }

    const totalDaysInMonth = new Date(year, month, 0).getDate();
    const perDay = totalDaysInMonth ? baseSalary / totalDaysInMonth : 0;
    const absentAmount = absentDays * perDay;
    const presentDays = Math.max(totalDaysInMonth - absentDays, 0);

    // No separate master-bonus term here (unlike create): the edit form's
    // reconstructed Travelling already folds in whatever the run originally
    // carried, so this reproduces the stored total exactly when unchanged.
    const totalAdditions = Number((otAmount + houseRent + travelling + railwayPass).toFixed(2));
    const grossSalary = Number((baseSalary + totalAdditions + incentive).toFixed(2));
    const totalDeduction = Number((empPT + absentAmount + advanceDeduction + emiAmount).toFixed(2));
    const takeAway = Number(Math.max(grossSalary - totalDeduction, 0).toFixed(2));

    const oldMonth = log.month;
    const oldYear = log.year;
    const payroll = await Payroll.findById(log.payroll);
    const isSnapshot = payroll && payroll.month === oldMonth && payroll.year === oldYear;

    log.month = month;
    log.year = year;
    log.presentDays = presentDays;
    log.absentDays = absentDays;
    log.otHours = otHours;
    log.incentive = incentive;
    log.totalAdditions = totalAdditions;
    log.advance = advanceDeduction;
    log.grossSalary = grossSalary;
    log.totalDeduction = totalDeduction;
    log.takeAway = takeAway;
    await log.save();

    if (isSnapshot) {
      payroll.month = month;
      payroll.year = year;
      payroll.presentDays = presentDays;
      payroll.absentDays = absentDays;
      payroll.otHours = otHours;
      payroll.incentive = incentive;
      payroll.totalAdditions = totalAdditions;
      payroll.advance = advanceDeduction;
      payroll.grossSalary = grossSalary;
      payroll.totalDeduction = totalDeduction;
      payroll.takeAway = takeAway;
      await payroll.save();
    }

    // If the period changed, move this run's advance/loan ledger rows with it
    // so a later delete can still find (and restore) them.
    if (month !== oldMonth || year !== oldYear) {
      const periodFilter = { employee: log.employee, month: oldMonth, year: oldYear, source: "PAYROLL" };
      await AdvanceLog.updateMany(periodFilter, { $set: { month, year } });
      await LoanLog.updateMany(periodFilter, { $set: { month, year } });
    }

    res.locals.auditDescription = `Edited payroll for "${emp.empName}" (${month}/${year}, take-away ₹${takeAway})`;
    req.flash("notification", "Payroll updated successfully");
    return res.redirect("/fairtech/payroll/view");
  } catch (err) {
    console.error("PAYROLL EDIT SAVE ERROR:", err);
    req.flash("error", "Failed to update payroll.");
    return res.redirect("back");
  }
});

/* CREATE PAYROLL */
router.post("/create", requireAuth, createLimiter, async (req, res) => {
  try {
    const { employeeId, month, year, presentDays, absentDays, incentive = 0 } = req.body;
    const othrs = Number(req.body.othrs || 0);

    /* FETCH EMPLOYEE */
    const emp = await Employee.findById(employeeId);
    if (!emp) {
      req.flash("error", "Employee not found");
      return res.redirect("back");
    }
    /* LOAN EMI: deduct exactly what was typed on the form, not the master default */
    let emiAmount = 0;
    const loan = await Loan.findOne({ employee: emp._id });

    if (loan && loan.status === "ACTIVE") {
      emiAmount = Math.max(Number(req.body.emi ?? loan.emi) || 0, 0);
    }

    /* BLOCK DUPLICATE PAYROLL (LOG LEVEL) */
    const alreadyLogged = await PayrollLog.findOne({
      employee: employeeId,
      month,
      year,
    });

    if (alreadyLogged) {
      req.flash("error", "Payroll already exists for this employee and month");
      return res.redirect("back");
    }

    /* ADVANCE (DEDUCTION RULE) */
    const advanceRecord = await Advance.findOne({ employee: employeeId });
    let advanceDeduction = 0;

    if (advanceRecord && advanceRecord.currentBalance > 0) {
      advanceDeduction = advanceRecord.currentBalance;
    }

    /* ABSENT CALCULATION */
    const totalDays = Number(presentDays) + Number(absentDays);
    const perDaySalary = totalDays ? emp.basicSalary / totalDays : 0;
    const absentAmount = Number(absentDays) * perDaySalary;

    /* ADDITIONS */
    const otAmount = Number(req.body.empOtAmount || 0);
    const houseRent = Number(req.body.houseRent || 0);
    const travelling = Number(req.body.travelling || 0);
    const railwayPass = Number(req.body.railwayPass || 0);
    const bonus = Number(req.body.bonus || 0);

    const totalAdditions = otAmount + houseRent + travelling + railwayPass + bonus;

    /* GROSS SALARY */
    const grossSalary = Number((Number(emp.basicSalary) + totalAdditions + Number(incentive)).toFixed(2));

    /* DEDUCTIONS */
    const empPT = Number(req.body.empPT ?? emp.empPT ?? 0);

    /* TOTAL DEDUCTIONS */
    const totalDeduction = Number(
      (
        empPT +
        absentAmount +
        advanceDeduction +
        emiAmount
      ).toFixed(2),
    );

    /* TAKE AWAY */
    const takeAway = Number(Math.max(grossSalary - totalDeduction, 0).toFixed(2));

    /* UPSERT PAYROLL (SNAPSHOT) */
    const payroll = await Payroll.findOneAndUpdate(
      { employee: emp._id },
      {
        employee: emp._id,
        month,
        year,
        presentDays,
        absentDays,
        otHours: othrs,

        baseSalary: emp.basicSalary,
        totalAdditions,
        incentive,
        advance: advanceDeduction,

        grossSalary,
        totalDeduction,
        takeAway,
      },
      { upsert: true, new: true },
    );

    /* PAYROLL LOG (HISTORY) */
    await PayrollLog.create({
      employee: emp._id,
      payroll: payroll._id,

      month,
      year,

      baseSalary: emp.basicSalary,
      presentDays,
      absentDays,
      otHours: othrs,

      totalAdditions,
      incentive,
      advance: advanceDeduction,

      grossSalary,
      totalDeduction,
      takeAway,

      source: "SYSTEM",
    });

    /* LOAN EMI DEDUCTION */
    if (emiAmount > 0 && loan) {
      const openingBalance = loan.currentBalance;
      const closingBalance = Math.max(openingBalance - emiAmount, 0);

      loan.currentBalance = closingBalance;
      loan.status = closingBalance === 0 ? "CLOSED" : "ACTIVE";
      await loan.save();

      await LoanLog.create({
        employee: emp._id,
        loan: loan._id,
        openingBalance,
        amount: emiAmount,
        closingBalance,
        type: "DEBIT",
        source: "PAYROLL",
        month,
        year,
      });
    }

    /* ADVANCE (LOGGED) */
    if (advanceDeduction > 0 && advanceRecord) {
      const openingBalance = advanceRecord.currentBalance;
      const closingBalance = openingBalance - advanceDeduction;

      advanceRecord.currentBalance = closingBalance;
      advanceRecord.status = closingBalance === 0 ? "CLOSED" : "ACTIVE";
      await advanceRecord.save();

      await AdvanceLog.create({
        employee: emp._id,
        advance: advanceRecord._id,
        openingBalance,
        amount: advanceDeduction,
        closingBalance,
        type: "DEBIT",
        source: "PAYROLL",
        month,
        year,
      });
    }

    res.locals.auditDescription = `Created payroll for "${emp.empName}" (${month}/${year}, take-away ₹${takeAway})`;
    req.flash("notification", "Payroll created successfully");
    return res.redirect("/fairtech/payroll/view");
  } catch (err) {
    console.error(err);
    req.flash("error", "Failed to create payroll");
    return res.redirect("back");
  }
});

/* FETCH LOAN */
router.get("/loan/:employeeId", async (req, res) => {
  try {
    const loan = await Loan.findOne({ employee: req.params.employeeId }).lean();
    res.json(loan || { currentBalance: 0 });
  } catch (err) {
    console.error("FETCH LOAN ERROR:", err);
    res.status(500).json({ error: "Failed to fetch loan." });
  }
});

/* FETCH ADVANCE */
router.get("/advance/:employeeId", async (req, res) => {
  try {
    const advance = await Advance.findOne({ employee: req.params.employeeId }).lean();
    res.json(advance || { currentBalance: 0 });
  } catch (err) {
    console.error("FETCH ADVANCE ERROR:", err);
    res.status(500).json({ error: "Failed to fetch advance." });
  }
});

/* PAYROLL DISPLAY (FULL MONTH-WISE HISTORY, FILTERABLE BY MONTH) */
router.get("/view", async (req, res) => {
  try {
    const logs = await PayrollLog.find({})
      .sort({ year: -1, month: -1, createdAt: -1 })
      .populate(
        "employee",
        "empName empId empUnder empDept empPT empTDS empLIC empMedical empNSIC empESIC empPF houseRent travelling railwayPass bonus otRatePerHour",
      )
      .lean();

    // Net loan EMI actually deducted per (employee, month, year) — the LoanLog
    // is the only place this per-run figure is recorded (PayrollLog only keeps
    // the lumped totalDeduction). Net = DEBIT − CREDIT so it reconciles even if
    // a run was topped up or partially reversed.
    const loanAgg = await LoanLog.aggregate([
      { $match: { source: "PAYROLL" } },
      {
        $group: {
          _id: { employee: "$employee", month: "$month", year: "$year" },
          net: { $sum: { $cond: [{ $eq: ["$type", "DEBIT"] }, "$amount", { $multiply: ["$amount", -1] }] } },
        },
      },
    ]);
    const loanByKey = new Map(
      loanAgg.map((r) => [`${r._id.employee}|${r._id.month}|${r._id.year}`, r.net]),
    );

  const jsonData = logs.map((p) => ({
    _id: p._id,
    employeeId: p.employee?._id,
    employeeName: p.employee?.empName || "-",
    empId: p.employee?.empId || "-",
    empUnder: p.employee?.empUnder || "-",
    empDept: p.employee?.empDept || "-",
    month: p.month,
    year: p.year,

    presentDays: p.presentDays,
    absentDays: p.absentDays,
    otHours: p.otHours,

    basicSalary: p.baseSalary || 0,
    totalAdditions: p.totalAdditions || 0,
    incentive: p.incentive || 0,
    advance: p.advance || 0,
    loanEmi: loanByKey.get(`${p.employee?._id}|${p.month}|${p.year}`) || 0,

    grossSalary: p.grossSalary,
    totalDeduction: p.totalDeduction,
    takeAway: p.takeAway,

    source: p.source,

    // Compensation profile from the employee master — the same source the
    // payroll form pre-fills these fields from. Shown as reference detail, not
    // as the per-run figures (only the totals above are stored per run).
    profile: {
      pt: p.employee?.empPT || 0,
      tds: p.employee?.empTDS || 0,
      lic: p.employee?.empLIC || 0,
      medical: p.employee?.empMedical || 0,
      nsic: p.employee?.empNSIC || 0,
      esic: p.employee?.empESIC || 0,
      pf: p.employee?.empPF || 0,
      houseRent: p.employee?.houseRent || 0,
      travelling: p.employee?.travelling || 0,
      railwayPass: p.employee?.railwayPass || 0,
      bonus: p.employee?.bonus || 0,
      otRatePerHour: p.employee?.otRatePerHour || 0,
    },
  }));

    res.render("accounting/payrollDisp", {
      jsonData,
      CSS: "tableDisp.css",
      JS: false,
      title: "Payroll View",
      navigator: "payroll",
      notification: req.flash("notification"),
      error: req.flash("error"),
    });
  } catch (err) {
    console.error("PAYROLL VIEW ERROR:", err);
    res.status(500).render("accounting/payrollDisp", {
      jsonData: [],
      CSS: "tableDisp.css",
      JS: false,
      title: "Payroll View",
      navigator: "payroll",
      error: ["Failed to load payroll records."],
    });
  }
});

/* EDIT PAYROLL RECORD */
router.patch("/logs/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const log = await PayrollLog.findById(id);
    if (!log) return res.status(404).json({ message: "Payroll record not found." });

    const month = Number(req.body.month ?? log.month);
    const year = Number(req.body.year ?? log.year);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return res.status(400).json({ message: "Month must be between 1 and 12." });
    }
    if (!Number.isInteger(year) || year < 2000 || year > 2100) {
      return res.status(400).json({ message: "Please enter a valid year." });
    }
    if (month !== log.month || year !== log.year) {
      const duplicate = await PayrollLog.findOne({
        _id: { $ne: log._id },
        employee: log.employee,
        month,
        year,
      }).lean();
      if (duplicate) {
        return res.status(400).json({ message: "Payroll already exists for this employee and month." });
      }
    }

    const presentDays = Number(req.body.presentDays ?? log.presentDays);
    const absentDays = Number(req.body.absentDays ?? log.absentDays);
    const otHours = Number(req.body.otHours ?? log.otHours);
    const incentive = Number(req.body.incentive ?? log.incentive);
    const totalAdditions = Number(req.body.totalAdditions ?? log.totalAdditions);
    const advance = Number(req.body.advance ?? log.advance);
    const totalDeduction = Number(req.body.totalDeduction ?? log.totalDeduction);

    const grossSalary = Number((Number(log.baseSalary) + totalAdditions + incentive).toFixed(2));
    const takeAway = Number(Math.max(grossSalary - totalDeduction, 0).toFixed(2));

    // Resolve whether this log is the employee's current Payroll snapshot
    // *before* the log's own month/year are overwritten below, so a month
    // edit still finds the matching snapshot by its old period.
    const payroll = await Payroll.findById(log.payroll);
    const isSnapshot = payroll && payroll.month === log.month && payroll.year === log.year;

    // Capture the period this payroll's advance/loan deductions are filed
    // under *before* it changes, so a month/year edit can move the linked
    // ledger rows with it. Delete finds those rows by period, so they must
    // stay in step or a later delete couldn't restore the balance.
    const oldMonth = log.month;
    const oldYear = log.year;

    log.month = month;
    log.year = year;
    log.presentDays = presentDays;
    log.absentDays = absentDays;
    log.otHours = otHours;
    log.incentive = incentive;
    log.totalAdditions = totalAdditions;
    log.advance = advance;
    log.totalDeduction = totalDeduction;
    log.grossSalary = grossSalary;
    log.takeAway = takeAway;
    await log.save();

    // Keep the employee's latest Payroll snapshot in sync, if this log is that snapshot
    if (isSnapshot) {
      payroll.month = month;
      payroll.year = year;
      payroll.presentDays = presentDays;
      payroll.absentDays = absentDays;
      payroll.otHours = otHours;
      payroll.incentive = incentive;
      payroll.totalAdditions = totalAdditions;
      payroll.advance = advance;
      payroll.grossSalary = grossSalary;
      payroll.totalDeduction = totalDeduction;
      payroll.takeAway = takeAway;
      await payroll.save();
    }

    // Move this run's advance/loan deduction rows onto the new period so the
    // delete flow (which locates them by month/year) can still find them.
    if (month !== oldMonth || year !== oldYear) {
      const periodFilter = { employee: log.employee, month: oldMonth, year: oldYear, source: "PAYROLL" };
      await AdvanceLog.updateMany(periodFilter, { $set: { month, year } });
      await LoanLog.updateMany(periodFilter, { $set: { month, year } });
    }

    const empDoc = await Employee.findById(log.employee).select("empName").lean();
    res.locals.auditDescription = `Edited payroll record for "${empDoc?.empName || log.employee}" (${log.month}/${log.year}, take-away ₹${takeAway})`;
    req.flash("notification", "Payroll record updated");
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ message: "Failed to update payroll record." });
  }
});

/* DELETE PAYROLL RECORD (restores the advance / loan balances it deducted) */
router.delete("/logs/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const log = await PayrollLog.findById(id);
    if (!log) return res.status(404).json({ message: "Payroll record not found." });

    /*
     * Undo this payroll run by REMOVING the ledger rows it created, then
     * replaying the ledger — not by tacking on a reversing CREDIT. That
     * leaves the advance/loan exactly where they were before this payroll
     * (no leftover DEBIT/CREDIT pair), and correctly restores the full
     * amount even when a run produced more than one deduction row for the
     * month (e.g. a capped deduction that was later topped up).
     */

    /* RESTORE LOAN EMI DEDUCTION TIED TO THIS PAYROLL RUN */
    const loanRows = await LoanLog.find({
      employee: log.employee,
      month: log.month,
      year: log.year,
      source: "PAYROLL",
    }).select("_id loan").lean();

    if (loanRows.length) {
      const loanId = loanRows[0].loan;
      await LoanLog.deleteMany({ _id: { $in: loanRows.map((r) => r._id) } });
      await recomputeLoanLedger(log.employee, loanId);
    }

    /* RESTORE ADVANCE DEDUCTION TIED TO THIS PAYROLL RUN */
    const advanceRows = await AdvanceLog.find({
      employee: log.employee,
      month: log.month,
      year: log.year,
      source: "PAYROLL",
    }).select("_id advance").lean();

    if (advanceRows.length) {
      const advanceId = advanceRows[0].advance;
      await AdvanceLog.deleteMany({ _id: { $in: advanceRows.map((r) => r._id) } });
      await recomputeAdvanceLedger(log.employee, advanceId);
    }

    await PayrollLog.findByIdAndDelete(id);

    /* REBUILD THE EMPLOYEE'S PAYROLL SNAPSHOT FROM REMAINING HISTORY */
    const remainingLogs = await PayrollLog.find({ employee: log.employee }).sort({ year: -1, month: -1, createdAt: -1 });

    if (remainingLogs.length) {
      const latest = remainingLogs[0];
      await Payroll.findOneAndUpdate(
        { employee: log.employee },
        {
          employee: log.employee,
          month: latest.month,
          year: latest.year,
          presentDays: latest.presentDays,
          absentDays: latest.absentDays,
          otHours: latest.otHours,
          totalAdditions: latest.totalAdditions,
          incentive: latest.incentive,
          advance: latest.advance,
          grossSalary: latest.grossSalary,
          totalDeduction: latest.totalDeduction,
          takeAway: latest.takeAway,
        },
        { upsert: true },
      );
    } else {
      await Payroll.findOneAndDelete({ employee: log.employee });
    }

    const empDoc = await Employee.findById(log.employee).select("empName").lean();
    res.locals.auditDescription = `Deleted payroll record for "${empDoc?.empName || log.employee}" (${log.month}/${log.year}) and reversed linked loan/advance deductions`;
    req.flash("notification", "Payroll record deleted");
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    return res.status(400).json({ message: "Failed to delete payroll record." });
  }
});

/* EMPLOYEE PAYROLL HISTORY */
router.get("/employee/:id/payrolls", async (req, res) => {
  try {
    const logs = await PayrollLog.find({ employee: req.params.id })
      .sort({ year: -1, month: -1 })
      .populate("employee", "empName empId")
      .lean();

    const history = logs.map((p) => ({
      _id: p._id,
      employeeId: p.employee?._id,
      employeeName: p.employee?.empName || "-",
      empId: p.employee?.empId || "-",

      month: p.month,
      year: p.year,

      presentDays: p.presentDays,
      absentDays: p.absentDays,
      otHours: p.otHours,

      basicSalary: p.baseSalary,
      totalAdditions: p.totalAdditions,
      incentive: p.incentive,
      advance: p.advance,

      grossSalary: p.grossSalary,
      totalDeduction: p.totalDeduction,
      takeAway: p.takeAway,

      source: p.source,
    }));

    res.json({ history });
  } catch (err) {
    console.error(err);
    res.status(500).json({ history: [] });
  }
});

/* FETCH EMPLOYEE (FOR PAYROLL & ADVANCE) */
router.get("/employee/:id", async (req, res) => {
  try {
    const emp = await Employee.findById(req.params.id).select("empId empName basicSalary").lean();

    if (!emp) return res.status(404).json(null);

    res.json({
      _id: emp._id,
      empId: emp.empId,
      empName: emp.empName,
      basicSalary: emp.basicSalary,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json(null);
  }
});

export default router;
