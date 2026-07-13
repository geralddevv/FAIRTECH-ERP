import mongoose from "mongoose";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import Employee from "../../models/hr/employee_model.js";
import SimCard from "../../models/hr/simcard_model.js";
import SimCardLog from "../../models/hr/SimCardLog.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Backfills the SIM Card master (/fairtech/simcard/view) from the Employee
 * master's "Office Mobile" field (empOfficeMob): any employee who has an
 * office mobile number but no matching SIM card yet gets one created, using
 * the same defaults as a manual assignment via the UI — employee name,
 * department, service provider AIRTEL, tracemate service NO.
 *
 * Skips employees who already have a SIM card (matched by employee id, or by
 * the mobile number itself — same duplicate rule the /simcard/create route
 * enforces) so re-running this script is safe.
 *
 * Idempotent: safe to re-run. Pass --apply to write; defaults to a dry run.
 */

const APPLY = process.argv.includes("--apply");
const PERFORMED_BY = "SYSTEM (backfill script)";

function buildSimCardSignature(mobileNumber) {
  const digits = String(mobileNumber ?? "").replace(/\D/g, "");
  return `sha256:${crypto.createHash("sha256").update(digits).digest("hex")}`;
}

async function run() {
  let uri = process.env.MONGO_URI || "mongodb://localhost:27017/fairdesk";
  const dbUser = process.env.MONGO_USER;
  const dbPass = process.env.MONGO_PASS;
  if (dbUser && dbPass && uri.startsWith("mongodb://") && !uri.includes("@")) {
    uri = uri.replace("mongodb://", `mongodb://${encodeURIComponent(dbUser)}:${encodeURIComponent(dbPass)}@`);
    if (!uri.includes("authSource")) uri += (uri.includes("?") ? "&" : "?") + "authSource=admin";
  }
  await mongoose.connect(uri);
  console.log(`Database connected.${APPLY ? "" : "  (DRY RUN — pass --apply to write changes)"}\n`);

  const employees = await Employee.find(
    { empOfficeMob: { $exists: true, $ne: "" } },
    "empName empOfficeMob empDept"
  ).lean();

  const existingSimCards = await SimCard.find({}, "employee mobileNumber simCardSignature").lean();
  const assignedEmployeeIds = new Set(
    existingSimCards.filter((s) => s.employee).map((s) => String(s.employee))
  );
  const usedMobileDigits = new Set(
    existingSimCards.map((s) => String(s.mobileNumber ?? "").replace(/\D/g, "")).filter(Boolean)
  );

  let created = 0;
  let skippedAlreadyAssigned = 0;
  let skippedDuplicateMobile = 0;

  for (const emp of employees) {
    const mobile = String(emp.empOfficeMob || "").trim();
    if (!mobile) continue;

    if (assignedEmployeeIds.has(String(emp._id))) {
      skippedAlreadyAssigned += 1;
      continue;
    }

    const digits = mobile.replace(/\D/g, "");
    if (usedMobileDigits.has(digits)) {
      console.warn(`  ? ${emp.empName} (${mobile}): a SIM card with this number already exists — skipped.`);
      skippedDuplicateMobile += 1;
      continue;
    }

    console.log(`  + ${emp.empName} (${mobile})${emp.empDept ? ` [${emp.empDept}]` : ""}`);

    if (APPLY) {
      const simCard = await SimCard.create({
        employee: emp._id,
        employeeName: emp.empName,
        isOthers: false,
        isUnassigned: false,
        department: emp.empDept || "",
        mobileNumber: mobile,
        serviceProvider: "AIRTEL",
        tracementService: "NO",
        simCardSignature: buildSimCardSignature(mobile),
      });

      await SimCardLog.create({
        simCardId: simCard._id,
        action: "ASSIGNED",
        employeeName: emp.empName,
        department: emp.empDept || "",
        mobileNumber: mobile,
        serviceProvider: "AIRTEL",
        tracementService: "NO",
        performedBy: PERFORMED_BY,
      });
    }

    usedMobileDigits.add(digits);
    assignedEmployeeIds.add(String(emp._id));
    created += 1;
  }

  console.log("\n================ Summary ================");
  console.log(`Employees with office mobile: ${employees.length}`);
  console.log(`${APPLY ? "Created" : "Would create"}: ${created}`);
  console.log(`Skipped (already has a SIM card): ${skippedAlreadyAssigned}`);
  console.log(`Skipped (mobile number already used by another SIM card): ${skippedDuplicateMobile}`);
  console.log("==========================================");
  console.log(APPLY ? "Done — changes written." : "Dry run complete — re-run with --apply to write these changes.");

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
