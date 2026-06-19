import express from "express";
import crypto from "crypto";
import Client from "../../models/users/client.js";
import Employee from "../../models/hr/employee_model.js";
import Username from "../../models/users/username.js";
import { escapeRegex } from "../../utils/security.js";
import { requireAuth } from "../../middleware/auth.js";
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

const router = express.Router();

function normalizeClientPart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function buildClientSignature(source) {
  return [
    normalizeClientPart(source.clientName),
    normalizeClientPart(source.clientType),
    normalizeClientPart(source.clientStatus),
    normalizeClientPart(source.hoLocation),
    normalizeClientPart(source.accountHead),
    normalizeClientPart(source.clientGst),
    normalizeClientPart(source.clientMsme),
    normalizeClientPart(source.clientGumasta),
    normalizeClientPart(source.clientPan),
  ].join("||");
}

function hashSignature(rawSignature) {
  return `sha256:${crypto
    .createHash("sha256")
    .update(String(rawSignature ?? ""))
    .digest("hex")}`;
}

router.use((req, res, next) => {
  const authUser = req.session?.authUser;
  const role = String(authUser?.role || "").toLowerCase();
  const permissions = authUser?.permissions || {};
  const hasSalesAccess = role === "sales" || Boolean(permissions.sales);
  const hasClientAccess = hasSalesAccess || Boolean(permissions.master);

  if (!role) return res.redirect("/login");

  if (role === "admin" || role === "hod") return next();

  if (hasClientAccess) {
    const path = req.path || "";
    const nPath = path.toLowerCase().replace(/\/$/, "");

    if (
      req.method === "GET" &&
      (nPath === "/view" || path.startsWith("/api/") || path.startsWith("/profile/") || path.startsWith("/details/") || path.startsWith("/edit/"))
    ) {
      return next();
    }

    if (req.method === "POST" && (path.includes("/delete") || path.includes("/edit/"))) {
      return next();
    }

    return res.redirect("/login");
  }

  return res.redirect("/login");
});

/* ================= CLIENTS VIEW ================= */
router.get("/view", async (req, res) => {
  try {
    const [clients, userCounts] = await Promise.all([
      Client.find(
        {},
        {
          clientId: 1,
          clientName: 1,
          clientType: 1,
          hoLocation: 1,
          accountHead: 1,
          clientGst: 1,
          clientPan: 1,
          clientMsme: 1,
          clientGumasta: 1,
          clientStatus: 1,
          users: 1,
        },
      )
        .sort({ clientName: 1 })
        .lean(),
      Username.aggregate([{ $group: { _id: "$clientId", count: { $sum: 1 } } }]),
    ]);

    const userCountByClientId = new Map(userCounts.map((entry) => [String(entry._id || ""), Number(entry.count || 0)]));

    clients.forEach((client) => {
      client.userCount = userCountByClientId.get(String(client.clientId || "")) || 0;
    });

    res.render("users/clientsView.ejs", {
      title: "Client View",
      jsonData: clients,
      CSS: "tableDisp.css",
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error(err);
    req.flash("notification", "Failed to load Clients");
    res.redirect("back");
  }
});

/* ================= CLIENT POPUP DATA ================= */
router.get("/api/:id", async (req, res) => {
  try {
    const client = await Client.findById(req.params.id, { __v: 0 });
    if (!client) return res.status(404).json({ error: "Client not found" });
    res.json(client);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

/* ================= EDIT CLIENT FORM ================= */
router.get("/edit/:id", async (req, res) => {
  try {
    const [client, employees] = await Promise.all([
      Client.findById(req.params.id),
      Employee.find({}, { empName: 1 }).sort({ empName: 1 }).lean(),
    ]);

    if (!client) {
      req.flash("notification", "Client not found");
      return res.redirect("/fairdesk/client/view");
    }

    res.render("users/clientEditForm.ejs", {
      title: "Edit Client",
      client,
      employees,
      JS: false,
      CSS: "tabOpt.css",
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error(err);
    req.flash("notification", "Failed to load client");
    res.redirect("/fairdesk/client/view");
  }
});

/* ================= UPDATE CLIENT ================= */
router.post("/edit/:id", requireAuth, updateLimiter, async (req, res) => {
  try {
    const currentClient = await Client.findById(req.params.id).select("clientId").lean();

    if (!currentClient) {
      return res.status(404).json({
        success: false,
        message: "Client not found",
      });
    }

    const clientName = String(req.body.clientName || "").trim();
    const clientType = String(req.body.clientType || "").trim();
    const clientStatus = String(req.body.clientStatus || "").trim();
    const hoLocation = String(req.body.hoLocation || "").trim();
    const accountHead = String(req.body.accountHead || "").trim();
    const clientGst = String(req.body.clientGst || "").trim().toUpperCase();
    const clientPan = String(req.body.clientPan || "").trim().toUpperCase();

    // GST and PAN Validation
    const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
    const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;

    if (clientGst && !gstRegex.test(clientGst)) {
      return res.status(400).json({ success: false, message: "Invalid GST number format" });
    }
    if (clientPan && !panRegex.test(clientPan)) {
      return res.status(400).json({ success: false, message: "Invalid PAN number format" });
    }
    if (clientGst && clientPan && clientGst.substring(2, 12) !== clientPan) {
      return res.status(400).json({ success: false, message: "PAN does not match GST number" });
    }

    const clientSignature = hashSignature(
      buildClientSignature({
        clientName,
        clientType,
        clientStatus,
        hoLocation,
        accountHead,
        clientGst,
        clientMsme,
        clientGumasta,
        clientPan,
      }),
    );

    // Block edit only when another client already has the same full entity.
    const duplicateClient = await Client.findOne({
      _id: { $ne: req.params.id },
      $or: [
        { clientSignature },
        {
          clientName: new RegExp(`^${escapeRegex(clientName)}$`, "i"),
          clientType: new RegExp(`^${escapeRegex(clientType)}$`, "i"),
          clientStatus: new RegExp(`^${escapeRegex(clientStatus)}$`, "i"),
          hoLocation: new RegExp(`^${escapeRegex(hoLocation)}$`, "i"),
          accountHead: new RegExp(`^${escapeRegex(accountHead)}$`, "i"),
          clientGst: new RegExp(`^${escapeRegex(clientGst)}$`, "i"),
          clientMsme: new RegExp(`^${escapeRegex(clientMsme)}$`, "i"),
          clientGumasta: new RegExp(`^${escapeRegex(clientGumasta)}$`, "i"),
          clientPan: new RegExp(`^${escapeRegex(clientPan)}$`, "i"),
        },
      ],
    }).lean();

    if (duplicateClient) {
      return res.status(400).json({
        success: false,
        message: "client already exist (same full details)",
      });
    }

    await Client.findByIdAndUpdate(
      req.params.id,
      {
        clientName,
        clientType,
        clientStatus,
        hoLocation,
        accountHead,
        clientGst,
        clientMsme,
        clientGumasta,
        clientPan,
        clientSignature,
      },
      {
        runValidators: true,
      },
    );

    await Username.updateMany(
      { clientId: currentClient.clientId },
      {
        $set: {
          clientId: currentClient.clientId,
          clientName,
          clientType,
          clientStatus,
          hoLocation,
          accountHead,
        },
      },
    );

    req.flash("notification", "Client updated successfully!");
    res.json({ success: true, redirect: "/fairdesk/client/view" });
  } catch (err) {
    console.error(err);
    res.status(400).json({ success: false, message: "Failed to update client" });
  }
});

/* ================= CLIENT PROFILE (OPTIONAL) ================= */
router.get("/profile/:id", async (req, res) => {
  try {
    const client = await Client.findById(req.params.id).populate({
      path: "users",
      populate: [
        { path: "label" },
        { path: "ttr", populate: { path: "ttrId" } },
        { path: "tape", populate: { path: "tapeId" } },
        { path: "posRoll", populate: { path: "posRollId" } },
        { path: "tafeta", populate: { path: "tafetaId" } },
      ],
    });

    if (!client) {
      req.flash("notification", "Client not found");
      return res.redirect("/fairdesk/client/view");
    }

    res.render("users/clientProfile.ejs", {
      title: "Client Profile",
      client,
      CSS: false,
      JS: false,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error(err);
    req.flash("notification", "Invalid client link");
    res.redirect("/fairdesk/client/view");
  }
});

/* ================= USER DETAILS ================= */
router.get("/details/:userId", async (req, res) => {
  try {
    const user = await Username.findById(req.params.userId)
      .populate("label")
      .populate({
        path: "ttr",
        populate: { path: "ttrId" },
      })
      .populate({
        path: "tape",
        populate: { path: "tapeId" },
      })
      .populate({
        path: "posRoll",
        populate: { path: "posRollId" },
      })
      .populate({
        path: "tafeta",
        populate: { path: "tafetaId" },
      });

    if (!user) {
      req.flash("notification", "User not found");
      return res.redirect("/fairdesk/master/view");
    }

    const userData = {
      _id: user._id,
      clientId: user.clientId,
      clientName: user.clientName,
      clientType: user.clientType,
      hoLocation: user.hoLocation,
      accountHead: user.accountHead,
      userName: user.userName,
      userContact: user.userContact,
      userEmail: user.userEmail,
      userLocation: user.userLocation,
      locationDetails: Array.isArray(user.locationDetails) ? user.locationDetails : [],
      userDepartment: user.userDepartment,
      SelfDispatch: user.SelfDispatch,
      dispatchAddress: user.dispatchAddress,
      transportName: user.transportName,
      transportContact: user.transportContact,
      dropLocation: user.dropLocation,
      deliveryMode: user.deliveryMode,
      deliveryLocation: user.deliveryLocation,
      clientPayment: user.clientPayment,
    };

    const stats = {
      labels: (user.label || []).length,
      ttrs: (user.ttr || []).length,
      tapes: (user.tape || []).length,
      posRolls: (user.posRoll || []).length,
      tafetas: (user.tafeta || []).length,
    };

    res.render("users/clientDetails.ejs", {
      title: "User Details",
      CSS: false,
      JS: false,
      userData,
      labels: user.label || [],
      ttrs: user.ttr || [],
      tapes: user.tape || [],
      posRolls: user.posRoll || [],
      tafetas: user.tafeta || [],
      stats,
      notification: req.flash("notification"),
    });
  } catch (err) {
    console.error("USER DETAILS ERROR:", err);
    req.flash("notification", "Failed to load user details");
    res.redirect("/fairdesk/master/view");
  }
});

/* ================= DELETE USER ================= */
router.post("/details/:userId/delete", requireAuth, deleteLimiter, async (req, res) => {
  try {
    const { userId } = req.params;
    const user = await Username.findById(userId).lean();
    if (!user) {
      req.flash("notification", "User not found");
      return res.redirect("/fairdesk/master/view");
    }
    await Client.updateOne({ clientId: user.clientId }, { $pull: { users: user._id } });
    await Username.deleteOne({ _id: user._id });
    req.flash("notification", `User ${user.userName} deleted successfully`);
    return res.redirect("/fairdesk/master/view");
  } catch (err) {
    console.error("USER DELETE ERROR:", err);
    req.flash("notification", "Failed to delete user");
    return res.redirect(`/fairdesk/client/details/${req.params.userId}`);
  }
});

export default router;
