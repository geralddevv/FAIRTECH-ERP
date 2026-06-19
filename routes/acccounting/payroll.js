import express from "express";
import Employee from "../../models/hr/employee_model.js";
import Payroll from "../../models/accounting/Payroll.js";
import PayrollLog from "../../models/accounting/PayrollLog.js";
import Loan from "../../models/accounting/Loan.js";
import LoanLog from "../../models/accounting/LoanLog.js";
import Advance from "../../models/accounting/Advance.js";
import AdvanceLog from "../../models/accounting/AdvanceLog.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

/* SHOW PAYROLL FORM */
router.get("/create", async (req, res) => {
  const employees = await Employee.find({ isActive: true }).sort({ empName: 1 });

  res.render("accounting/payroll", {
    employees,
    CSS: false,
    JS: false,
    title: "Payroll",
    navigator: "payroll",
    notification: req.flash("notification"),
    error: req.flash("error"),
  });
});

/* CREATE PAYROLL */
router.post("/create", requireAuth, createLimiter, async (req, res) => {
  try {
    const { employeeId, month, year, presentDays, absentDays, othrs = 0, incentive = 0 } = req.body;

    /* FETCH EMPLOYEE */
    const emp = await Employee.findById(employeeId);
    if (!emp) {
      req.flash("error", "Employee not found");
      return res.redirect("back");
    }
    /* FETCH EMI FROM LOAN MASTER */
    let emiAmount = 0;
    const loan = await Loan.findOne({ employee: emp._id });

    if (loan && loan.status === "ACTIVE") {
      emiAmount = loan.emi;
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
      const maxAdvanceAllowed = emp.basicSalary * 0.5;
      advanceDeduction = Math.min(advanceRecord.currentBalance, maxAdvanceAllowed);
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

    /* TOTAL DEDUCTIONS */
    const totalDeduction = Number(
      (
        Number(emp.empPF || 0) +
        Number(emp.empESIC || 0) +
        Number(emp.empPT || 0) +
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

    req.flash("notification", "Payroll created successfully");
    return res.redirect("/fairdesk/payroll/view");
  } catch (err) {
    console.error(err);
    req.flash("error", "Failed to create payroll");
    return res.redirect("back");
  }
});

/* FETCH LOAN */
router.get("/loan/:employeeId", async (req, res) => {
  const loan = await Loan.findOne({ employee: req.params.employeeId }).lean();
  res.json(loan || { currentBalance: 0 });
});

/* FETCH ADVANCE */
router.get("/advance/:employeeId", async (req, res) => {
  const advance = await Advance.findOne({ employee: req.params.employeeId }).lean();
  res.json(advance || { currentBalance: 0 });
});

/* PAYROLL DISPLAY (LATEST PER EMPLOYEE) */
router.get("/view", async (req, res) => {
  const payrolls = await Payroll.aggregate([
    { $sort: { year: -1, month: -1, createdAt: -1 } },
    {
      $group: {
        _id: "$employee",
        latestPayroll: { $first: "$$ROOT" },
      },
    },
    { $replaceRoot: { newRoot: "$latestPayroll" } },
  ]);

  await Payroll.populate(payrolls, {
    path: "employee",
    select: "empName empId basicSalary",
  });

  const monthMap = {
    1: "Jan",
    2: "Feb",
    3: "Mar",
    4: "Apr",
    5: "May",
    6: "Jun",
    7: "Jul",
    8: "Aug",
    9: "Sep",
    10: "Oct",
    11: "Nov",
    12: "Dec",
  };

  const jsonData = payrolls.map((p) => ({
    employeeId: p.employee?._id,
    employeeName: p.employee?.empName || "-",
    empId: p.employee?.empId || "-",
    month: monthMap[p.month],
    year: p.year,

    presentDays: p.presentDays,
    absentDays: p.absentDays,
    otHours: p.otHours,

    basicSalary: p.employee?.basicSalary || 0,
    totalAdditions: p.totalAdditions || 0,
    incentive: p.incentive || 0,
    advance: p.advance || 0,

    grossSalary: p.grossSalary,
    totalDeduction: p.totalDeduction,
    takeAway: p.takeAway,
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
});

/* EMPLOYEE PAYROLL HISTORY */
router.get("/employee/:id/payrolls", async (req, res) => {
  try {
    const logs = await PayrollLog.find({ employee: req.params.id })
      .sort({ year: -1, month: -1 })
      .populate("employee", "empName empId")
      .lean();

    const history = logs.map((p) => ({
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
