import express from "express";
import Tafeta from "../../models/inventory/tafeta.js";
import TafetaBinding from "../../models/inventory/tafetaBinding.js";
import TafetaStock from "../../models/inventory/TafetaStock.js";
import Client from "../../models/users/client.js";
import Username from "../../models/users/username.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

/* GET : Load Tafeta Binding Form */
router.get("/form/tafeta-binding", async (req, res) => {
  try {
    const [clients, materialCodes, materialTypes, colors, gsms, widths, mtrsList, coreLens, notches, coreIds] =
      await Promise.all([
        Client.distinct("clientName"),
        Tafeta.distinct("tafetaMaterialCode"),
        Tafeta.distinct("tafetaMaterialType"),
        Tafeta.distinct("tafetaColor"),
        Tafeta.distinct("tafetaGsm"),
        Tafeta.distinct("tafetaWidth"),
        Tafeta.distinct("tafetaMtrs"),
        Tafeta.distinct("tafetaCoreLen"),
        Tafeta.distinct("tafetaNotch"),
        Tafeta.distinct("tafetaCoreId"),
      ]);

    res.render("inventory/tafetaBinding.ejs", {
      title: "Client Tafeta",
      clients,
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
      materialCodes,
      materialTypes,
      colors,
      gsms,
      widths,
      mtrsList,
      coreLens,
      notches,
      coreIds,
    });
  } catch (err) {
    console.error(err);
    req.flash("notification", "Failed to load Tafeta Binding");
    res.redirect("back");
  }
});

/* POST : Save Tafeta Binding */
router.post("/form/tafeta-binding", requireAuth, createLimiter, async (req, res) => {
  try {
    const { userId, tafetaId } = req.body;

    // Validate user exists
    const user = await Username.findById(userId);
    if (!user) {
      return res.status(400).json({ success: false, message: "Invalid user selected" });
    }

    // Check for duplicate binding
    const existingBinding = await TafetaBinding.exists({
      userId,
      tafetaId,
      tafetaClientMaterialCode: req.body.tafetaClientMaterialCode,
      tafetaClientMaterialType: req.body.tafetaClientMaterialType,
      clientTafetaGsm: req.body.clientTafetaGsm,
      tafetaRatePerRoll: Number(req.body.tafetaRatePerRoll),
      tafetaSaleCost: Number(req.body.tafetaSaleCost),
      tafetaMinQty: Number(req.body.tafetaMinQty),
      tafetaOdrQty: Number(req.body.tafetaOdrQty),
      tafetaOdrFreq: req.body.tafetaOdrFreq,
      tafetaCreditTerm: req.body.tafetaCreditTerm,
      tafetaMtrsDel: req.body.tafetaMtrsDel,
    });
    if (existingBinding) {
      return res
        .status(400)
        .json({ success: false, message: "This exact Tafeta binding configuration already exists for this user." });
    }

    // Create Tafeta binding
    const tafetaBinding = await TafetaBinding.create({
      ...req.body,
      tafetaRatePerRoll: Number(req.body.tafetaRatePerRoll),
      tafetaSaleCost: Number(req.body.tafetaSaleCost),
      tafetaMinQty: Number(req.body.tafetaMinQty),
      tafetaOdrQty: Number(req.body.tafetaOdrQty),
      userId,
      tafetaId,
    });

    // Attach to user
    user.tafeta.push(tafetaBinding._id);
    await user.save();

    req.flash("notification", "Tafeta binding created successfully!");
    res.json({ success: true, redirect: "/fairdesk/client/details/" + userId });
  } catch (err) {
    console.error("TAFETA BINDING ERROR:", err);
    res.status(400).json({ success: false, message: err.message });
  }
});

/* GET : Fetch Users by Client (AJAX) */
router.get("/form/tafeta-binding/client/:name", async (req, res) => {
  try {
    const clientData = await Client.findOne({ clientName: req.params.name }).populate("users");
    res.status(200).json(clientData);
  } catch (err) {
    console.error(err);
    res.status(500).json(null);
  }
});

/* GET : Filter Tafeta Specs (cascading smart form) */
router.get("/form/tafeta-binding/filter-specs", async (req, res) => {
  try {
    const {
      tafetaMaterialCode,
      tafetaMaterialType,
      tafetaColor,
      tafetaGsm,
      tafetaWidth,
      tafetaMtrs,
      tafetaCoreLen,
      tafetaNotch,
      tafetaCoreId,
    } = req.query;

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

    const buildFilter = (excludeKey) => {
      const f = {};
      if (tafetaMaterialCode && excludeKey !== "tafetaMaterialCode") f.tafetaMaterialCode = flex(tafetaMaterialCode);
      if (tafetaMaterialType && excludeKey !== "tafetaMaterialType") f.tafetaMaterialType = flex(tafetaMaterialType);
      if (tafetaColor && excludeKey !== "tafetaColor") f.tafetaColor = flex(tafetaColor);
      if (tafetaGsm && excludeKey !== "tafetaGsm") f.tafetaGsm = flex(tafetaGsm);
      if (tafetaWidth && excludeKey !== "tafetaWidth") f.tafetaWidth = flex(tafetaWidth);
      if (tafetaMtrs && excludeKey !== "tafetaMtrs") f.tafetaMtrs = flex(tafetaMtrs);
      if (tafetaCoreLen && excludeKey !== "tafetaCoreLen") f.tafetaCoreLen = flex(tafetaCoreLen);
      if (tafetaNotch && excludeKey !== "tafetaNotch") f.tafetaNotch = flex(tafetaNotch);
      if (tafetaCoreId && excludeKey !== "tafetaCoreId") f.tafetaCoreId = flex(tafetaCoreId);
      return f;
    };

    const [materialCodes, materialTypes, colors, gsms, widths, mtrsList, coreLens, notches, coreIds] =
      await Promise.all([
        Tafeta.distinct("tafetaMaterialCode", buildFilter("tafetaMaterialCode")),
        Tafeta.distinct("tafetaMaterialType", buildFilter("tafetaMaterialType")),
        Tafeta.distinct("tafetaColor", buildFilter("tafetaColor")),
        Tafeta.distinct("tafetaGsm", buildFilter("tafetaGsm")),
        Tafeta.distinct("tafetaWidth", buildFilter("tafetaWidth")),
        Tafeta.distinct("tafetaMtrs", buildFilter("tafetaMtrs")),
        Tafeta.distinct("tafetaCoreLen", buildFilter("tafetaCoreLen")),
        Tafeta.distinct("tafetaNotch", buildFilter("tafetaNotch")),
        Tafeta.distinct("tafetaCoreId", buildFilter("tafetaCoreId")),
      ]);

    res.json({ materialCodes, materialTypes, colors, gsms, widths, mtrsList, coreLens, notches, coreIds });
  } catch (err) {
    console.error("FILTER SPECS ERROR:", err);
    res.status(500).json(null);
  }
});

/* GET : Resolve Tafeta from Specifications */
router.get("/form/tafeta-binding/resolve-tafeta", async (req, res) => {
  try {
    const {
      tafetaMaterialCode,
      tafetaMaterialType,
      tafetaColor,
      tafetaGsm,
      tafetaWidth,
      tafetaMtrs,
      tafetaCoreLen,
      tafetaNotch,
      tafetaCoreId,
    } = req.query;

    if (
      !tafetaMaterialCode ||
      !tafetaMaterialType ||
      !tafetaColor ||
      !tafetaGsm ||
      !tafetaWidth ||
      !tafetaMtrs ||
      !tafetaCoreLen ||
      !tafetaNotch ||
      !tafetaCoreId
    ) {
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

    const tafeta = await Tafeta.findOne({
      tafetaMaterialCode: flex(tafetaMaterialCode),
      tafetaMaterialType: flex(tafetaMaterialType),
      tafetaColor: flex(tafetaColor),
      tafetaGsm: flex(tafetaGsm),
      tafetaWidth: flex(tafetaWidth),
      tafetaMtrs: flex(tafetaMtrs),
      tafetaCoreLen: flex(tafetaCoreLen),
      tafetaNotch: flex(tafetaNotch),
      tafetaCoreId: flex(tafetaCoreId),
    }).lean();

    if (!tafeta) {
      return res.status(404).json(null);
    }

    res.status(200).json({
      tafetaId: tafeta._id,
      tafetaProductId: tafeta.tafetaProductId,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json(null);
  }
});

/* GET : Display bound Tafeta */
router.get("/tafeta/view/:id", async (req, res) => {
  try {
    const user = await Username.findById(req.params.id)
      .populate({
        path: "tafeta",
        populate: [
          { path: "tafetaId", model: "Tafeta" }, 
          { path: "userId", model: "Username" }, 
        ],
      })
      .lean();

    if (!user) {
      req.flash("notification", "User not found");
      return res.redirect("back");
    }

    const tafetaData = user.tafeta || [];
    const tafetaIds = tafetaData.map((binding) => binding.tafetaId?._id).filter(Boolean);
    const stockMap = {};
    if (tafetaIds.length) {
      const stockAgg = await TafetaStock.aggregate([
        { $match: { tafeta: { $in: tafetaIds } } },
        { $group: { _id: "$tafeta", total: { $sum: "$quantity" } } },
      ]);
      stockAgg.forEach((row) => {
        stockMap[row._id.toString()] = row.total;
      });
    }
    tafetaData.forEach((binding) => {
      const tid = binding.tafetaId?._id?.toString();
      binding.stock = stockMap[tid] || 0;
    });

    res.render("inventory/tafetaDisp.ejs", {
      jsonData: tafetaData,
      CSS: "tableDisp.css",
      JS: false,
      title: "Tafeta Display",
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("TAFETA VIEW ERROR:", err);
    res.redirect("back");
  }
});

/* GET : Compare Client Tafeta vs Master */
router.get("/tafeta/compare/:id", async (req, res) => {
  try {
    const binding = await TafetaBinding.findById(req.params.id)
      .populate({ path: "tafetaId", model: "Tafeta" })
      .populate({ path: "userId", model: "Username" })
      .lean();

    if (!binding) {
      req.flash("notification", "Tafeta binding not found");
      return res.redirect("back");
    }

    const tafeta = binding.tafetaId || {};
    const user = binding.userId || {};

    const compareRows = [
      {
        field: "Material Code",
        orgValue: tafeta.tafetaMaterialCode || "N/A",
        clientValue: binding.tafetaClientMaterialCode || "N/A",
      },
      {
        field: "Material Type",
        orgValue: tafeta.tafetaMaterialType || "N/A",
        clientValue: binding.tafetaClientMaterialType || "N/A",
      },
      { field: "Color", orgValue: tafeta.tafetaColor || "N/A", clientValue: tafeta.tafetaColor || "N/A" },
      { field: "GSM", orgValue: tafeta.tafetaGsm || "N/A", clientValue: binding.clientTafetaGsm || "N/A" },
      { field: "Width", orgValue: tafeta.tafetaWidth ?? "N/A", clientValue: tafeta.tafetaWidth ?? "N/A" },
      { field: "Meters", orgValue: tafeta.tafetaMtrs || "N/A", clientValue: tafeta.tafetaMtrs || "N/A" },
      { field: "Core Length", orgValue: tafeta.tafetaCoreLen || "N/A", clientValue: tafeta.tafetaCoreLen || "N/A" },
      { field: "Notch", orgValue: tafeta.tafetaNotch || "N/A", clientValue: tafeta.tafetaNotch || "N/A" },
      { field: "Core ID", orgValue: tafeta.tafetaCoreId || "N/A", clientValue: tafeta.tafetaCoreId || "N/A" },
      { field: "Minimum Qty", orgValue: "-", clientValue: binding.tafetaMinQty ?? "N/A" },
      { field: "Order Qty", orgValue: "-", clientValue: binding.tafetaOdrQty ?? "N/A" },
      { field: "Order Frequency", orgValue: "-", clientValue: binding.tafetaOdrFreq || "N/A" },
      { field: "Credit Term", orgValue: "-", clientValue: binding.tafetaCreditTerm || "N/A" },
      { field: "Rate Per Roll", orgValue: "-", clientValue: binding.tafetaRatePerRoll ?? "N/A" },
      { field: "Sale Cost", orgValue: "-", clientValue: binding.tafetaSaleCost ?? "N/A" },
      { field: "Meters Delivered", orgValue: "-", clientValue: binding.tafetaMtrsDel ?? "N/A" },
      { field: "Status", orgValue: "-", clientValue: binding.status || "N/A" },
    ];

    res.render("inventory/itemCompare.ejs", {
      title: "Tafeta Compare",
      CSS: false,
      JS: false,
      itemTitle: "Tafeta Details",
      sectionTitle: "Tafeta Details (Fairtech - Client)",
      orgLabel: "Fairtech",
      clientLabel: "Client",
      editBindingUrl: `/fairdesk/tafeta-binding/edit/${binding._id}`,
      clientName: user?.clientName || "",
      userName: user?.userName || "",
      compareRows,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("TAFETA COMPARE ERROR:", err);
    req.flash("notification", "Failed to load Tafeta comparison");
    res.redirect("back");
  }
});

/* GET : Load Tafeta Binding Edit Form */
router.get("/tafeta-binding/edit/:id", async (req, res) => {
  try {
    const binding = await TafetaBinding.findById(req.params.id).populate("tafetaId").populate("userId");

    if (!binding) {
      req.flash("notification", "Tafeta binding not found");
      return res.redirect("back");
    }

    res.render("inventory/tafetaBindingEdit.ejs", {
      title: "Edit Tafeta Binding",
      binding,
      returnTo: typeof req.query.returnTo === "string" ? req.query.returnTo : "",
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("EDIT BINDING GET ERROR:", err);
    req.flash("notification", "Failed to load Tafeta Binding Edit");
    res.redirect("back");
  }
});

/* POST : Update Tafeta Binding */
router.post("/tafeta-binding/edit/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const {
      tafetaClientMaterialCode,
      tafetaClientMaterialType,
      clientTafetaGsm,
      tafetaMtrsDel,
      tafetaRatePerRoll,
      tafetaSaleCost,
      tafetaMinQty,
      tafetaOdrQty,
      tafetaOdrFreq,
      tafetaCreditTerm,
      status,
      returnTo,
    } = req.body;

    const binding = await TafetaBinding.findById(id);
    if (!binding) {
      req.flash("notification", "Binding not found");
      return res.redirect("back");
    }

    binding.tafetaClientMaterialCode = tafetaClientMaterialCode;
    binding.tafetaClientMaterialType = tafetaClientMaterialType;
    binding.clientTafetaGsm = clientTafetaGsm;
    binding.tafetaMtrsDel = tafetaMtrsDel;
    binding.tafetaRatePerRoll = Number(tafetaRatePerRoll);
    binding.tafetaSaleCost = Number(tafetaSaleCost);
    binding.tafetaMinQty = Number(tafetaMinQty);
    binding.tafetaOdrQty = Number(tafetaOdrQty);
    binding.tafetaOdrFreq = tafetaOdrFreq;
    binding.tafetaCreditTerm = tafetaCreditTerm;

    if (status) {
      binding.status = status;
    }

    await binding.save();

    req.flash("notification", "Tafeta binding updated successfully!");

    if (typeof returnTo === "string" && returnTo.startsWith("/fairdesk/")) {
      return res.redirect(returnTo);
    }

    res.redirect("/fairdesk/tafeta/view/" + binding.userId);
  } catch (err) {
    console.error("EDIT BINDING POST ERROR:", err);
    if (err.code === 11000) {
      req.flash("notification", "A Tafeta binding with this exact configuration already exists.");
    } else {
      req.flash("notification", "Failed to update Tafeta Binding");
    }
    res.redirect("back");
  }
});

router.post("/tafeta-binding/delete/:id", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { id } = req.params;
    const binding = await TafetaBinding.findById(id).select("userId").lean();

    if (!binding) {
      req.flash("notification", "Tafeta binding not found");
      return res.redirect("back");
    }

    await TafetaBinding.deleteOne({ _id: id });
    await Username.updateOne({ _id: binding.userId }, { $pull: { tafeta: id } });

    req.flash("notification", "Tafeta binding removed successfully!");
    return res.redirect(`/fairdesk/tafeta/view/${binding.userId}`);
  } catch (err) {
    console.error("TAFETA BINDING DELETE ERROR:", err);
    req.flash("notification", "Failed to remove Tafeta binding");
    return res.redirect("back");
  }
});

export default router;
