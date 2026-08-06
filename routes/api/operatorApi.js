import express from "express";
import mongoose from "mongoose";
import { randomUUID } from "crypto";
import Location from "../../models/system/location.js";
import PendingProduction from "../../models/inventory/PendingProduction.js";
import PaperStock from "../../models/inventory/PaperStock.js";
import Machine from "../../models/system/machine.js";
import MaintenanceRequest from "../../models/system/maintenanceRequest.js";
import { authenticateOperator } from "../../utils/operatorAuth.js";
import { signOperatorApiToken, requireOperatorApiAuth, requireOperatorApiMediaAuth } from "../../middleware/apiAuth.js";
import { buildRollLabelPrn } from "../../utils/rollLabelPrn.js";
import { loginLimiter, createLimiter } from "../../utils/limiters.js";
import {
  buildQueueRows,
  buildOperatorQueue,
  allotmentGateMessage,
  saveJobCard,
  previewId,
} from "../system/machine.js";
import {
  createOperatorTicket,
  toMaintenanceRow,
  resolveOperatorMachine,
  listMachinesAtLocation,
  serveMaintenanceAsset,
  maintenanceUpload,
  MaintenanceInputError,
} from "../system/maintenance.js";

/*
 * JSON API for the Fairtech Operator mobile app (a separate bare React Native
 * project). Every other route in this codebase is server-rendered EJS with
 * cookie-session auth + CSRF, neither of which a native client can use
 * naturally -- this router is bearer-token authenticated instead (see
 * middleware/apiAuth.js) and mounted in server.js *before* the global CSRF
 * middleware, the same "exempt from CSRF" pattern already used for
 * /check-session.
 *
 * All business logic here is reused, not reimplemented, from
 * routes/system/machine.js's exports -- this file is deliberately thin.
 */
const router = express.Router();

router.post("/login", loginLimiter, async (req, res) => {
  const { operatorNick, location, password } = req.body || {};
  const result = await authenticateOperator({ operatorNick, location, password });
  if (result.error) {
    return res.status(result.status || 401).json({ error: result.error });
  }

  const { authUser } = result;
  const token = signOperatorApiToken(authUser);
  res.json({
    token,
    empName: authUser.empName,
    empLoc: authUser.empLoc,
    empObjId: authUser.empObjId,
    empPhoto: authUser.empPhoto,
    profileCode: authUser.profileCode,
  });
});

router.get("/locations", async (req, res) => {
  const locations = await Location.find({}).sort({ locationName: 1 }).select("locationName").lean();
  res.json({ locations: locations.map((l) => l.locationName) });
});

router.get("/queue", requireOperatorApiAuth, async (req, res) => {
  const queue = await buildOperatorQueue({
    empObjId: req.authUser.empObjId,
    empName: req.authUser.empName,
    empLoc: req.authUser.empLoc,
  });
  res.json(queue);
});

router.get("/jobcard/:pendingId", requireOperatorApiAuth, async (req, res) => {
  const { pendingId } = req.params;
  if (!mongoose.isValidObjectId(pendingId)) {
    return res.status(400).json({ error: "Invalid pendingId" });
  }

  const pendingDoc = await PendingProduction.findById(pendingId).select("assignedMachineId operatorId").lean();
  if (!pendingDoc) {
    return res.status(404).json({ error: "Not found" });
  }
  // An operator can only open a job card for work assigned to *them* -- unlike
  // the staff-facing web route (requireMachineFloor, no per-job ownership
  // check needed there since staff legitimately look at any job), the mobile
  // app is operator-only, so this is the one place that ownership has to be
  // enforced explicitly rather than falling out of "which page can you even
  // reach."
  if (String(pendingDoc.operatorId || "") !== req.authUser.empObjId) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const machine = pendingDoc.assignedMachineId ? await Machine.findById(pendingDoc.assignedMachineId).lean() : null;
  const rows = pendingDoc.assignedMachineId
    ? await buildQueueRows({ assignedMachineId: pendingDoc.assignedMachineId })
    : [];
  const prefill = rows.find((r) => r._id === String(pendingId)) || null;

  const gateMessage = allotmentGateMessage(prefill);
  if (gateMessage) {
    return res.status(409).json({ error: gateMessage, rollsStatus: prefill?.rollsStatus ?? null });
  }

  const previewJobCardId = await previewId("jobCardId", "JC");
  res.json({
    pendingId: String(pendingId),
    machine,
    prefill,
    previewJobCardId,
    submissionToken: randomUUID(),
  });
});

router.post("/jobcard", requireOperatorApiAuth, createLimiter, async (req, res) => {
  const body = req.body || {};

  if (mongoose.isValidObjectId(body.pendingId)) {
    const pendingDoc = await PendingProduction.findById(body.pendingId).select("operatorId").lean();
    if (!pendingDoc || String(pendingDoc.operatorId || "") !== req.authUser.empObjId) {
      return res.status(403).json({ error: "Forbidden" });
    }
  }

  try {
    const outcome = await saveJobCard({ body, actorName: req.authUser.empName });
    if (outcome.status === "duplicate") {
      return res.json({ status: "duplicate", pendingId: outcome.pendingId });
    }
    if (outcome.status === "gate-failed" || outcome.status === "reel-cap-exceeded") {
      return res.status(409).json({ status: outcome.status, message: outcome.message });
    }
    return res.json({
      status: "ok",
      jobCardId: outcome.jobCardId,
      pendingId: outcome.pendingId,
      consumption: outcome.consumption,
    });
  } catch (err) {
    console.error("OPERATOR API JOB CARD ERROR:", err);
    res.status(500).json({ error: "Failed to save production entry" });
  }
});

router.get("/rolls/:stockId/prn", requireOperatorApiAuth, async (req, res) => {
  const { stockId } = req.params;
  if (!mongoose.isValidObjectId(stockId)) {
    return res.status(400).json({ error: "Invalid roll id" });
  }

  // Scoped deliberately: only serve TSPL for a reel that's actually allotted
  // to one of *this operator's own* jobs, rather than opening up
  // buildRollLabelPrn to any authenticated operator for any reel in the
  // system (the existing staff-only .prn download route has no such per-user
  // scoping, which is fine there since only office staff can reach it at all).
  const owningJob = await PendingProduction.findOne({
    operatorId: req.authUser.empObjId,
    allottedRollIds: stockId,
  })
    .select("_id")
    .lean();
  if (!owningJob) {
    return res.status(403).json({ error: "Forbidden" });
  }

  const reel = await PaperStock.findById(stockId).select("rollId vendorRollId paperSize paperMtrs").lean();
  if (!reel) {
    return res.status(404).json({ error: "Roll not found" });
  }

  const tspl = buildRollLabelPrn({
    rollId: reel.rollId,
    vendorRollId: reel.vendorRollId,
    paperSize: reel.paperSize,
    paperMtrs: reel.paperMtrs,
  });
  res.json({ tspl });
});

/*
 * Maintenance -- the JSON mirror of the operator's server-rendered Maintenance
 * tab (routes/system/maintenance.js). Both reuse the same helpers there, so the
 * web page and the app create and read identical tickets; the only difference
 * is these return JSON instead of rendering EJS and are bearer-authed.
 */

// The operator's own tickets (newest first) + the machine picker for the
// report form. Same payload the web page renders from -- toMaintenanceRow.
router.get("/maintenance", requireOperatorApiAuth, async (req, res) => {
  const authUser = req.authUser;
  const operatorObjId = authUser?.empObjId;

  const docs =
    operatorObjId && mongoose.isValidObjectId(operatorObjId)
      ? await MaintenanceRequest.find({ raisedById: operatorObjId }).sort({ createdAt: -1 }).lean()
      : [];

  const { machineId, machineName, locationName } = await resolveOperatorMachine(authUser);
  const machines = await listMachinesAtLocation(locationName);

  res.json({
    machineName,
    locationName,
    machines: machines.map((m) => ({ _id: String(m._id), machineName: m.machineName })),
    defaultMachineId: machineId ? String(machineId) : "",
    requests: docs.map(toMaintenanceRow),
  });
});

// Raise a ticket: a required description, an optional photo (multipart, the
// `photo` field), and an optional machine id. maintenanceUpload parses the
// upload; createOperatorTicket does the validation, storage and write.
router.post("/maintenance", requireOperatorApiAuth, createLimiter, maintenanceUpload, async (req, res) => {
  try {
    const { ticket } = await createOperatorTicket({
      authUser: req.authUser,
      description: req.body.description,
      requestedMachineId: req.body.machineId,
      files: req.files,
    });
    const row = toMaintenanceRow(ticket);
    // ticketNo at the top level too: the app's report form reads res.ticketNo
    // straight off the response to confirm the ticket to the operator.
    res.json({ success: true, ticketNo: row.ticketNo, ticket: row });
  } catch (err) {
    if (!(err instanceof MaintenanceInputError)) console.error("OPERATOR API MAINTENANCE CREATE ERROR:", err);
    res.status(err.statusCode || 400).json({ success: false, message: err.message || "Could not report the issue." });
  }
});

// One ticket attachment (or ?/thumb) by ticket id + position. Authed via
// requireOperatorApiMediaAuth (Bearer header OR ?token= query param, since RN's
// <Image> can't reliably send headers on Android) and scoped to the operator
// who raised it, via serveMaintenanceAsset's viewer check.
const serveApiAttachment = (thumb) => (req, res) =>
  serveMaintenanceAsset(res, {
    id: req.params.id,
    index: req.params.index,
    thumb,
    viewer: { role: req.authUser?.role, empObjId: req.authUser?.empObjId },
  });

router.get("/maintenance/media/:id/:index", requireOperatorApiMediaAuth, serveApiAttachment(false));
router.get("/maintenance/media/:id/:index/thumb", requireOperatorApiMediaAuth, serveApiAttachment(true));

export default router;
