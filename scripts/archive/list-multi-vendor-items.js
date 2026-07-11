import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import Tape from "../../models/inventory/tape.js";
import Ttr from "../../models/inventory/ttr.js";
import PosRoll from "../../models/inventory/posRoll.js";
import Tafeta from "../../models/inventory/tafeta.js";
import VendorTapeBinding from "../../models/inventory/vendorTapeBinding.js";
import VendorTtrBinding from "../../models/inventory/vendorTtrBinding.js";
import VendorPosRollBinding from "../../models/inventory/vendorPosRollBinding.js";
import VendorTafetaBinding from "../../models/inventory/vendorTafetaBinding.js";
import VendorUser from "../../models/users/vendorUser.js";

/*
 * Read-only report: lists master items (Tape/TTR/PosRoll/Tafeta) that have
 * more than one vendor binding, so we know whether "one vendor per item" is
 * a safe assumption before wiring a Vendor column onto the compare pages.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

const KINDS = [
  {
    label: "Tape",
    Master: Tape,
    VendorBinding: VendorTapeBinding,
    masterIdField: "tapeId",
    masterCode: (m) => m.tapeProductId,
    vendorCode: (b) => b.vendorTapePaperCode,
  },
  {
    label: "TTR",
    Master: Ttr,
    VendorBinding: VendorTtrBinding,
    masterIdField: "ttrId",
    masterCode: (m) => m.ttrProductId,
    vendorCode: (b) => b.vendorTtrMaterialCode,
  },
  {
    label: "PosRoll",
    Master: PosRoll,
    VendorBinding: VendorPosRollBinding,
    masterIdField: "posRollId",
    masterCode: (m) => m.posProductId,
    vendorCode: (b) => b.vendorPosPaperCode,
  },
  {
    label: "Tafeta",
    Master: Tafeta,
    VendorBinding: VendorTafetaBinding,
    masterIdField: "tafetaId",
    masterCode: (m) => m.tafetaProductId,
    vendorCode: (b) => b.vendorTafetaMaterialCode,
  },
];

async function run() {
  let uri = process.env.MONGO_URI || "mongodb://localhost:27017/fairdesk";
  const user = process.env.MONGO_USER;
  const pass = process.env.MONGO_PASS;
  if (user && pass && uri.startsWith("mongodb://") && !uri.includes("@")) {
    uri = uri.replace("mongodb://", `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`);
    if (!uri.includes("authSource")) uri += (uri.includes("?") ? "&" : "?") + "authSource=admin";
  }
  await mongoose.connect(uri);
  console.log("Database connected.\n");

  for (const kind of KINDS) {
    const masters = await kind.Master.find().lean();
    const masterById = new Map(masters.map((m) => [String(m._id), m]));

    const bindings = await kind.VendorBinding.find()
      .populate({ path: "vendorUserId", model: "VendorUser" })
      .lean();

    const byMaster = new Map();
    for (const b of bindings) {
      const key = String(b[kind.masterIdField] || "");
      if (!key) continue;
      if (!byMaster.has(key)) byMaster.set(key, []);
      byMaster.get(key).push(b);
    }

    const multi = [...byMaster.entries()].filter(([, list]) => list.length > 1);

    console.log(`=== ${kind.label}: ${multi.length} item(s) with multiple vendor bindings (of ${masters.length} total master items) ===`);
    for (const [masterId, list] of multi) {
      const master = masterById.get(masterId);
      const label = master ? kind.masterCode(master) : `(missing master ${masterId})`;
      console.log(`  ${label}  [${list.length} vendors]`);
      for (const b of list) {
        const vendorName = b.vendorUserId?.vendorName || b.vendorUserId?.userName || "(unknown vendor)";
        console.log(`    - ${vendorName} | status=${b.status || "N/A"} | code=${kind.vendorCode(b) || "N/A"} | updatedAt=${b.updatedAt?.toISOString?.() || "N/A"}`);
      }
    }
    console.log("");
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
