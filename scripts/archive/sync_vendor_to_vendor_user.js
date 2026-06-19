import crypto from "crypto";
import mongoose from "mongoose";
import path from "path";
import { fileURLToPath } from "url";
import { configDotenv } from "dotenv";
import connectDB from "../../config/db.js";
import Vendor from "../../models/users/vendor.js";
import VendorUser from "../../models/users/vendorUser.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

configDotenv({
  path: path.resolve(__dirname, "..", ".env"),
  quiet: true,
});

const SYNC_FIELDS = [
  "vendorId",
  "vendorName",
  "vendorStatus",
  "hoLocation",
  "warehouseLocation",
  "vendorGst",
  "vendorMsme",
];

function normalize(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}

function buildVendorUserSignature(source, vendorId) {
  return [
    normalize(vendorId),
    normalize(source.userName).toUpperCase(),
    normalize(source.userEmail).toLowerCase(),
    normalize(source.userContact).replace(/\D/g, ""),
  ].join("||");
}

function buildVendorSnapshot(vendor) {
  return {
    vendorId: normalize(vendor.vendorId),
    vendorName: normalize(vendor.vendorName),
    vendorStatus: normalize(vendor.vendorStatus),
    hoLocation: normalize(vendor.hoLocation),
    warehouseLocation: normalize(vendor.warehouseLocation),
    vendorGst: normalize(vendor.vendorGst),
    vendorMsme: normalize(vendor.vendorMsme),
  };
}

function collectMismatches(vendorSnapshot, vendorUser) {
  const diffs = {};

  for (const field of SYNC_FIELDS) {
    const currentValue = normalize(vendorUser[field]);
    const desiredValue = normalize(vendorSnapshot[field]);

    if (currentValue !== desiredValue) {
      diffs[field] = { from: currentValue, to: desiredValue };
    }
  }

  const nextSignature = hashSignature(buildVendorUserSignature(vendorUser, vendorSnapshot.vendorId));
  if (normalize(vendorUser.vendorUserSignature) !== nextSignature) {
    diffs.vendorUserSignature = {
      from: normalize(vendorUser.vendorUserSignature),
      to: nextSignature,
    };
  }

  return diffs;
}

async function fetchLinkedVendorUsers(vendor) {
  const ids = Array.isArray(vendor.users)
    ? vendor.users
        .map((id) => String(id || "").trim())
        .filter(Boolean)
    : [];

  const usersById = ids.length
    ? await VendorUser.find({ _id: { $in: ids } }).lean()
    : [];
  const usersByVendorId = vendor.vendorId
    ? await VendorUser.find({ vendorId: vendor.vendorId }).lean()
    : [];

  const merged = new Map();
  for (const user of [...usersById, ...usersByVendorId]) {
    merged.set(String(user._id), user);
  }

  return [...merged.values()];
}

async function main() {
  const applyMode = process.argv.includes("--apply");

  console.log("");
  console.log("Vendor coordinator sync");
  console.log(`Mode: ${applyMode ? "APPLY" : "DRY-RUN"}`);
  console.log("");

  await connectDB();

  try {
    const vendors = await Vendor.find({}).lean();
    console.log(`Found ${vendors.length} vendor records.`);

    let vendorCount = 0;
    let userCount = 0;
    let updatedCount = 0;
    let changedFieldCount = 0;

    for (const vendor of vendors) {
      const vendorSnapshot = buildVendorSnapshot(vendor);
      const linkedUsers = await fetchLinkedVendorUsers(vendor);

      if (!linkedUsers.length) {
        continue;
      }

      vendorCount += 1;

      for (const vendorUser of linkedUsers) {
        const diffs = collectMismatches(vendorSnapshot, vendorUser);
        const diffKeys = Object.keys(diffs);
        if (!diffKeys.length) {
          continue;
        }

        userCount += 1;
        changedFieldCount += diffKeys.length;

        console.log(`Mismatch: ${vendorSnapshot.vendorName || vendorSnapshot.vendorId} -> ${vendorUser.userName || vendorUser._id}`);
        for (const [field, change] of Object.entries(diffs)) {
          console.log(`  ${field}: "${change.from}" -> "${change.to}"`);
        }

        if (applyMode) {
          const updateData = { ...vendorSnapshot };
          if (diffs.vendorUserSignature) {
            updateData.vendorUserSignature = diffs.vendorUserSignature.to;
          } else {
            updateData.vendorUserSignature = hashSignature(buildVendorUserSignature(vendorUser, vendorSnapshot.vendorId));
          }

          await VendorUser.updateOne({ _id: vendorUser._id }, { $set: updateData });
          updatedCount += 1;
          console.log("  -> updated");
        }
        console.log("");
      }
    }

    console.log("Summary");
    console.log(`  Vendors scanned:      ${vendors.length}`);
    console.log(`  Vendors with users:   ${vendorCount}`);
    console.log(`  Mismatched coordinators: ${userCount}`);
    console.log(`  Fields changed:      ${changedFieldCount}`);
    if (applyMode) {
      console.log(`  Records updated:      ${updatedCount}`);
    }

    if (!applyMode) {
      console.log("");
      console.log("Run with --apply to write the changes:");
      console.log("  node scripts/sync_vendor_to_vendor_user.js --apply");
    }
  } catch (error) {
    console.error("Vendor coordinator sync failed:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log("Disconnected.");
  }
}

main();
