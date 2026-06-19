import express from "express";
import Tape from "../../models/inventory/tape.js";
import TapeBinding from "../../models/inventory/tapeBinding.js";
import TapeStock from "../../models/inventory/TapeStock.js";
import Client from "../../models/users/client.js";
import Username from "../../models/users/username.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

/* GET : Load Tape Binding Form */
router.get("/form/tape-binding", async (req, res) => {
  try {
    const [clients, paperCodes, paperTypes, gsms, widths, mtrsList, coreIds, finishes] = await Promise.all([
      Client.distinct("clientName"),
      Tape.distinct("tapePaperCode"),
      Tape.distinct("tapePaperType"),
      Tape.distinct("tapeGsm"),
      Tape.distinct("tapeWidth"),
      Tape.distinct("tapeMtrs"),
      Tape.distinct("tapeCoreId"),
      Tape.distinct("tapeFinish"),
    ]);

    // console.log(paperCodes, paperTypes, gsms, widths, mtrsList);

    res.render("inventory/tapeBinding.ejs", {
      title: "Client Tape",
      clients,
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
      paperCodes,
      paperTypes,
      gsms,
      widths,
      mtrsList,
      coreIds,
      finishes,
    });
  } catch (err) {
    console.error(err);
    req.flash("notification", "Failed to load Tape Binding");
    res.redirect(req.get("Referrer") || "/");
  }
});

/* POST : Save Tape Binding */
router.post("/form/tape-binding", requireAuth, createLimiter, async (req, res) => {
  try {
    const { userId, tapeId } = req.body;

    // Validate user exists
    const user = await Username.findById(userId);
    if (!user) {
      return res.status(400).json({ success: false, message: "Invalid user selected" });
    }

    // Check for duplicate binding (same user, same tape, same client paper code, AND ALL OTHER SPECS)
    const existingBinding = await TapeBinding.exists({
      userId,
      tapeId,
      tapeClientPaperCode: req.body.tapeClientPaperCode,
      clientTapeGsm: Number(req.body.clientTapeGsm),
      tapeRatePerRoll: Number(req.body.tapeRatePerRoll),
      tapeSaleCost: Number(req.body.tapeSaleCost),
      tapeMinQty: Number(req.body.tapeMinQty),
      tapeOdrQty: Number(req.body.tapeOdrQty),
      tapeOdrFreq: req.body.tapeOdrFreq,
      tapeCreditTerm: req.body.tapeCreditTerm,
      // tapeMtrsDel is typically 0 on create, but if they pass it, we should check it to be "exact" match as requested
      tapeMtrsDel: Number(req.body.tapeMtrsDel || 0),
    });
    if (existingBinding) {
      return res
        .status(400)
        .json({ success: false, message: "This exact tape binding configuration already exists for this user." });
    }

    // Create tape binding with user reference
    const tapeBinding = await TapeBinding.create({
      ...req.body,
      clientTapeGsm: Number(req.body.clientTapeGsm),
      tapeRatePerRoll: Number(req.body.tapeRatePerRoll),
      tapeSaleCost: Number(req.body.tapeSaleCost),
      tapeMinQty: Number(req.body.tapeMinQty),
      tapeOdrQty: Number(req.body.tapeOdrQty),
      tapeMtrsDel: Number(req.body.tapeMtrsDel || 0),
      userId, // persisted safely
      tapeId,
    });

    // Attach tapeBinding to user (like label/ttr)
    user.tape.push(tapeBinding._id);
    await user.save();

    req.flash("notification", "Tape binding created successfully!");
    res.json({ success: true, redirect: "/fairdesk/client/details/" + userId });
  } catch (err) {
    console.error("TAPE BINDING ERROR:", err);
    res.status(400).json({ success: false, message: err.message });
  }
});

/* GET : Fetch Users by Client (AJAX) */
router.get("/form/tape-binding/client/:name", async (req, res) => {
  try {
    const clientData = await Client.findOne({ clientName: req.params.name }).populate("users");

    res.status(200).json(clientData);
  } catch (err) {
    console.error(err);
    res.status(500).json(null);
  }
});

/* GET : Filter Tape Specs (cascading smart form) */
router.get("/form/tape-binding/filter-specs", async (req, res) => {
  try {
    const { tapePaperCode, tapePaperType, tapeGsm, tapeWidth, tapeMtrs, tapeCoreId, tapeFinish } = req.query;

    const flex = (val) => {
      if (!val && val !== 0) return val;
      const arr = [val];
      if (typeof val === "string") {
        const t = val.trim();
        if (t !== val) arr.push(t);
        const n = Number(t);
        if (t !== "" && !isNaN(n)) arr.push(n);
      } else {
        arr.push(String(val));
      }
      return { $in: arr };
    };

    // Helper to build filter excluding one key so user can change selection
    const buildFilter = (excludeKey) => {
      const f = {};
      if (tapePaperCode && excludeKey !== "tapePaperCode") f.tapePaperCode = flex(tapePaperCode);
      if (tapePaperType && excludeKey !== "tapePaperType") f.tapePaperType = flex(tapePaperType);
      if (tapeGsm && excludeKey !== "tapeGsm") f.tapeGsm = flex(tapeGsm);
      if (tapeWidth && excludeKey !== "tapeWidth") f.tapeWidth = flex(tapeWidth);
      if (tapeMtrs && excludeKey !== "tapeMtrs") f.tapeMtrs = flex(tapeMtrs);
      if (tapeCoreId && excludeKey !== "tapeCoreId") f.tapeCoreId = flex(tapeCoreId);
      if (tapeFinish && excludeKey !== "tapeFinish") f.tapeFinish = flex(tapeFinish);
      return f;
    };

    const [paperCodes, paperTypes, gsms, widths, mtrsList, coreIds, finishes] = await Promise.all([
      Tape.distinct("tapePaperCode", buildFilter("tapePaperCode")),
      Tape.distinct("tapePaperType", buildFilter("tapePaperType")),
      Tape.distinct("tapeGsm", buildFilter("tapeGsm")),
      Tape.distinct("tapeWidth", buildFilter("tapeWidth")),
      Tape.distinct("tapeMtrs", buildFilter("tapeMtrs")),
      Tape.distinct("tapeCoreId", buildFilter("tapeCoreId")),
      Tape.distinct("tapeFinish", buildFilter("tapeFinish")),
    ]);

    res.json({ paperCodes, paperTypes, gsms, widths, mtrsList, coreIds, finishes });
  } catch (err) {
    console.error("FILTER SPECS ERROR:", err);
    res.status(500).json(null);
  }
});

/* GET : Resolve Tape from Specifications */
router.get("/form/tape-binding/resolve-tape", async (req, res) => {
  console.log("Resolve query:", req.query);
  try {
    const { tapePaperCode, tapePaperType, tapeGsm, tapeWidth, tapeMtrs, tapeCoreId, tapeFinish } = req.query;

    if (!tapePaperCode || !tapePaperType || !tapeGsm || !tapeWidth || !tapeMtrs || !tapeCoreId || !tapeFinish) {
      return res.status(400).json(null);
    }

    const flex = (val) => {
      if (!val && val !== 0) return val;
      const arr = [val];
      if (typeof val === "string") {
        const t = val.trim();
        if (t !== val) arr.push(t);
        const n = Number(t);
        if (t !== "" && !isNaN(n)) arr.push(n);
      } else {
        arr.push(String(val));
      }
      return { $in: arr };
    };

    const tape = await Tape.findOne({
      tapePaperCode: flex(tapePaperCode),
      tapePaperType: flex(tapePaperType),
      tapeGsm: flex(tapeGsm),
      tapeWidth: flex(tapeWidth),
      tapeMtrs: flex(tapeMtrs),
      tapeCoreId: flex(tapeCoreId),
      tapeFinish: flex(tapeFinish),
    }).lean();

    if (!tape) {
      return res.status(404).json(null);
    }

    res.status(200).json({
      tapeId: tape._id,
      tapeProductId: tape.tapeProductId,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json(null);
  }
});

/* GET : Display Bound Tapes */
router.get("/tape/view/:id", async (req, res) => {
  try {
    const user = await Username.findById(req.params.id)
      .populate({
        path: "tape",
        populate: [
          { path: "tapeId", model: "Tape" }, // Tape Master
          { path: "userId", model: "Username" }, // User ref
        ],
      })
      .lean();

    if (!user) {
      req.flash("notification", "User not found");
      return res.redirect(req.get("Referrer") || "/");
    }

    // Fetch stock for all bound tapes in one aggregation to avoid N+1 queries
    const tapeData = user.tape || [];
    const tapeIds = tapeData.map((binding) => binding.tapeId?._id).filter(Boolean);

    const stockMap = {};
    if (tapeIds.length) {
      const stockAgg = await TapeStock.aggregate([
        { $match: { tape: { $in: tapeIds } } },
        { $group: { _id: "$tape", total: { $sum: "$quantity" } } },
      ]);
      stockAgg.forEach((row) => {
        stockMap[row._id.toString()] = row.total;
      });
    }

    tapeData.forEach((binding) => {
      const tid = binding.tapeId?._id?.toString();
      binding.stock = stockMap[tid] || 0;
    });

    res.render("inventory/tapeDisp.ejs", {
      jsonData: tapeData,
      CSS: "tableDisp.css",
      JS: false,
      title: "Tape Display",
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("TAPE VIEW ERROR:", err);
    res.redirect(req.get("Referrer") || "/");
  }
});

/* GET : Compare Client Tape vs Master */
router.get("/tape/compare/:id", async (req, res) => {
  try {
    const binding = await TapeBinding.findById(req.params.id)
      .populate({ path: "tapeId", model: "Tape" })
      .populate({ path: "userId", model: "Username" })
      .lean();

    if (!binding) {
      req.flash("notification", "Tape binding not found");
      return res.redirect(req.get("Referrer") || "/");
    }

    const tape = binding.tapeId || {};
    const user = binding.userId || {};

    const compareRows = [
      { field: "Paper Code", orgValue: tape.tapePaperCode || "N/A", clientValue: binding.tapeClientPaperCode || "N/A" },
      { field: "GSM", orgValue: tape.tapeGsm ?? "N/A", clientValue: binding.clientTapeGsm ?? "N/A" },
      { field: "Paper Type", orgValue: tape.tapePaperType || "N/A", clientValue: tape.tapePaperType || "N/A" },
      { field: "Width", orgValue: tape.tapeWidth ?? "N/A", clientValue: tape.tapeWidth ?? "N/A" },
      { field: "Meters", orgValue: tape.tapeMtrs ?? "N/A", clientValue: tape.tapeMtrs ?? "N/A" },
      { field: "Core ID", orgValue: tape.tapeCoreId ?? "N/A", clientValue: tape.tapeCoreId ?? "N/A" },
      { field: "Finish", orgValue: tape.tapeFinish || "N/A", clientValue: tape.tapeFinish || "N/A" },
      { field: "Adhesive GSM", orgValue: tape.tapeAdhesiveGsm || "N/A", clientValue: tape.tapeAdhesiveGsm || "N/A" },
      { field: "Minimum Qty", orgValue: "-", clientValue: binding.tapeMinQty ?? "N/A" },
      { field: "Order Qty", orgValue: "-", clientValue: binding.tapeOdrQty ?? "N/A" },
      { field: "Order Frequency", orgValue: "-", clientValue: binding.tapeOdrFreq || "N/A" },
      { field: "Credit Term", orgValue: "-", clientValue: binding.tapeCreditTerm || "N/A" },
      { field: "Rate Per Roll", orgValue: "-", clientValue: binding.tapeRatePerRoll ?? "N/A" },
      { field: "Sale Cost", orgValue: "-", clientValue: binding.tapeSaleCost ?? "N/A" },
      { field: "Meters Delivered", orgValue: "-", clientValue: binding.tapeMtrsDel ?? 0 },
      { field: "Status", orgValue: "-", clientValue: binding.status || "N/A" },
    ];

    res.render("inventory/itemCompare.ejs", {
      title: "Tape Compare",
      CSS: false,
      JS: false,
      itemTitle: "Tape Details",
      sectionTitle: "Tape Details (Fairtech - Client)",
      orgLabel: "Fairtech",
      clientLabel: "Client",
      editBindingUrl: `/fairdesk/tape-binding/edit/${binding._id}`,
      clientName: user?.clientName || "",
      userName: user?.userName || "",
      compareRows,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("TAPE COMPARE ERROR:", err);
    req.flash("notification", "Failed to load Tape comparison");
    res.redirect(req.get("Referrer") || "/");
  }
});

/* GET : Load Tape Binding Edit Form */
router.get("/tape-binding/edit/:id", async (req, res) => {
  try {
    const binding = await TapeBinding.findById(req.params.id).populate("tapeId").populate("userId");

    if (!binding) {
      req.flash("notification", "Tape binding not found");
      return res.redirect(req.get("Referrer") || "/");
    }

    res.render("inventory/tapeBindingEdit.ejs", {
      title: "Edit Tape Binding",
      binding,
      returnTo: typeof req.query.returnTo === "string" ? req.query.returnTo : "",
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("EDIT BINDING GET ERROR:", err);
    req.flash("notification", "Failed to load Tape Binding Edit");
    res.redirect(req.get("Referrer") || "/");
  }
});

/* POST : Update Tape Binding */
router.post("/tape-binding/edit/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      tapeClientPaperCode,
      clientTapeGsm,
      tapeMtrsDel,
      tapeRatePerRoll,
      tapeSaleCost,
      tapeMinQty,
      tapeOdrQty,
      tapeOdrFreq,
      tapeCreditTerm,
      status,
      returnTo,
      itemClientItemType,
    } = req.body;

    const binding = await TapeBinding.findById(id);
    if (!binding) {
      req.flash("notification", "Binding not found");
      return res.redirect(req.get("Referrer") || "/");
    }

    binding.tapeClientPaperCode = tapeClientPaperCode;
    binding.clientTapeGsm = Number(clientTapeGsm);
    binding.tapeMtrsDel = Number(tapeMtrsDel);
    binding.tapeRatePerRoll = Number(tapeRatePerRoll);
    binding.tapeSaleCost = Number(tapeSaleCost);
    binding.tapeMinQty = Number(tapeMinQty);
    binding.tapeOdrQty = Number(tapeOdrQty);
    binding.tapeOdrFreq = tapeOdrFreq;
    binding.tapeCreditTerm = tapeCreditTerm;

    if (status) {
      binding.status = status;
    }

    binding.itemClientItemType = itemClientItemType;
    await binding.save();

    req.flash("notification", "Tape binding updated successfully!");

    if (typeof returnTo === "string" && returnTo.startsWith("/fairdesk/")) {
      return res.redirect(returnTo);
    }

    res.redirect("/fairdesk/tape/view/" + binding.userId);
  } catch (err) {
    console.error("EDIT BINDING POST ERROR:", err);
    if (err.code === 11000) {
      req.flash("notification", "A tape binding with this exact configuration already exists.");
    } else {
      req.flash("notification", "Failed to update Tape Binding");
    }
    res.redirect(req.get("Referrer") || "/");
  }
});

router.post("/tape-binding/delete/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const binding = await TapeBinding.findById(id).select("userId").lean();

    if (!binding) {
      req.flash("notification", "Tape binding not found");
      return res.redirect(req.get("Referrer") || "/");
    }

    await TapeBinding.deleteOne({ _id: id });
    await Username.updateOne({ _id: binding.userId }, { $pull: { tape: id } });

    req.flash("notification", "Tape binding removed successfully!");
    return res.redirect(`/fairdesk/tape/view/${binding.userId}`);
  } catch (err) {
    console.error("TAPE BINDING DELETE ERROR:", err);
    req.flash("notification", "Failed to remove Tape binding");
    return res.redirect("back");
  }
});

export default router;
