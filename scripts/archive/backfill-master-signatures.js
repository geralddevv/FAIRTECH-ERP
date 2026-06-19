import { configDotenv } from "dotenv";
import crypto from "crypto";
import mongoose from "mongoose";
import connectDB from "../../config/db.js";
import Client from "../../models/users/client.js";
import Username from "../../models/users/username.js";
import Vendor from "../../models/users/vendor.js";
import VendorUser from "../../models/users/vendorUser.js";
import Tape from "../../models/inventory/tape.js";
import PosRoll from "../../models/inventory/posRoll.js";
import Tafeta from "../../models/inventory/tafeta.js";
import Ttr from "../../models/inventory/ttr.js";

configDotenv({ quiet: true });

function normalizePart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}

function normalizeClientPart(value) {
  return normalizePart(value);
}

function normalizeUserName(value) {
  return normalizePart(value).toUpperCase();
}

function normalizeUserEmail(value) {
  return normalizePart(value).toLowerCase();
}

function normalizeUserContact(value) {
  return normalizePart(value).replace(/\D/g, "");
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

function buildUserSignature(source, clientId) {
  return [
    normalizeClientPart(clientId),
    normalizeUserName(source.userName),
    normalizeUserEmail(source.userEmail),
    normalizeUserContact(source.userContact),
  ].join("||");
}

function normalizeVendorPart(value) {
  return normalizePart(value);
}

function buildVendorSignature(source) {
  return [
    normalizeVendorPart(source.vendorName),
    normalizeVendorPart(source.vendorStatus),
    normalizeVendorPart(source.hoLocation),
    normalizeVendorPart(source.warehouseLocation),
    normalizeVendorPart(source.vendorGst),
    normalizeVendorPart(source.vendorMsme),
    normalizeVendorPart(source.vendorGumasta),
    normalizeVendorPart(source.vendorPan),
    Array.isArray(source.commodities)
      ? source.commodities.map((c) => normalizeVendorPart(c)).filter(Boolean).join(",")
      : normalizeVendorPart(source.commodities),
  ].join("||");
}

function buildVendorUserSignature(source, vendorId) {
  return [
    normalizeVendorPart(vendorId),
    normalizeUserName(source.userName),
    normalizeUserEmail(source.userEmail),
    normalizeUserContact(source.userContact),
  ].join("||");
}

function buildTapeSignature(source) {
  return [
    normalizePart(source.tapePaperCode),
    normalizePart(source.tapePaperType),
    normalizePart(source.tapeGsm),
    normalizePart(source.tapeWidth),
    normalizePart(source.tapeMtrs),
    normalizePart(source.tapeCoreId),
    normalizePart(source.tapeAdhesiveGsm),
    normalizePart(source.tapeFinish),
  ].join("||");
}

function buildPosSignature(source) {
  return [
    normalizePart(source.posPaperCode),
    normalizePart(source.posPaperType),
    normalizePart(source.posColor),
    normalizePart(source.posGsm),
    normalizePart(source.posWidth),
    normalizePart(source.posMtrs),
    normalizePart(source.posCoreId),
  ].join("||");
}

function buildTafetaSignature(source) {
  return [
    normalizePart(source.tafetaMaterialCode),
    normalizePart(source.tafetaMaterialType),
    normalizePart(source.tafetaColor),
    normalizePart(source.tafetaGsm),
    normalizePart(source.tafetaWidth),
    normalizePart(source.tafetaMtrs),
    normalizePart(source.tafetaCoreLen),
    normalizePart(source.tafetaNotch),
    normalizePart(source.tafetaCoreId),
  ].join("||");
}

function buildTtrSignature(source) {
  return [
    normalizePart(source.ttrType),
    normalizePart(source.ttrColor),
    normalizePart(source.ttrMaterialCode),
    normalizePart(source.ttrWidth),
    normalizePart(source.ttrMtrs),
    normalizePart(source.ttrInkFace),
    normalizePart(source.ttrCoreId),
    normalizePart(source.ttrCoreLength),
    normalizePart(source.ttrNotch),
    normalizePart(source.ttrWinding),
  ].join("||");
}

async function backfillModel(Model, label, signatureField, buildSignature) {
  const docs = await Model.find({}).lean();
  const seen = new Map();
  let updated = 0;
  let skipped = 0;
  const conflicts = [];

  for (const doc of docs) {
    const computedSignature = buildSignature(doc);
    const hashedSignature = hashSignature(computedSignature);
    const currentSignature = normalizePart(doc[signatureField]);

    if (currentSignature === hashedSignature) {
      seen.set(hashedSignature, String(doc._id));
      continue;
    }

    if (seen.has(hashedSignature)) {
      if (currentSignature && !currentSignature.startsWith("sha256:")) {
        await Model.updateOne({ _id: doc._id }, { $unset: { [signatureField]: "" } });
      }
      conflicts.push({
        signature: hashedSignature,
        firstId: seen.get(hashedSignature),
        duplicateId: String(doc._id),
      });
      skipped += 1;
      continue;
    }

    const result = await Model.updateOne(
      { _id: doc._id },
      { $set: { [signatureField]: hashedSignature } },
    );

    if (result.modifiedCount > 0) {
      updated += 1;
      seen.set(hashedSignature, String(doc._id));
    }
  }

  console.log(`${label}: updated ${updated}, skipped ${skipped}, total ${docs.length}`);
  if (conflicts.length) {
    console.log(`${label}: duplicate signatures detected and left untouched:`);
    for (const conflict of conflicts) {
      console.log(`  - ${conflict.signature} | first=${conflict.firstId} duplicate=${conflict.duplicateId}`);
    }
  }

  return { updated, skipped, total: docs.length, conflicts };
}

async function main() {
  await connectDB();
  console.log("Connected to DB");

  const results = [];
  results.push(await backfillModel(Client, "Client", "clientSignature", buildClientSignature));
  results.push(await backfillModel(Username, "User", "userSignature", (doc) => buildUserSignature(doc, doc.clientId)));
  results.push(await backfillModel(Vendor, "Vendor", "vendorSignature", buildVendorSignature));
  results.push(await backfillModel(VendorUser, "Vendor User", "vendorUserSignature", (doc) => buildVendorUserSignature(doc, doc.vendorId)));
  results.push(await backfillModel(Tape, "Tape", "tapeSignature", buildTapeSignature));
  results.push(await backfillModel(PosRoll, "POS Roll", "posSignature", buildPosSignature));
  results.push(await backfillModel(Tafeta, "Tafeta", "tafetaSignature", buildTafetaSignature));
  results.push(await backfillModel(Ttr, "TTR", "ttrSignature", buildTtrSignature));

  const totalUpdated = results.reduce((sum, r) => sum + r.updated, 0);
  const totalSkipped = results.reduce((sum, r) => sum + r.skipped, 0);
  console.log(`Backfill complete. Updated ${totalUpdated}, skipped ${totalSkipped}.`);
}

main()
  .catch((err) => {
    console.error("Backfill failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await mongoose.disconnect();
  });
