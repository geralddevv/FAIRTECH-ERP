/**
 * Migrate vendors (and their coordinators) from the fairdesk DB into the
 * separate `sachiko` database, writing to the STANDARD collections.
 *
 * - Reads `vendors` whose commodities include Adhesive / Face paper /
 *   Release paper / Core from the source (fairdesk) DB and writes them into
 *   `vendors` in the target (sachiko) DB with SP | VENDOR | 001 IDs.
 * - Reads the associated `vendorusers` from the source DB and writes them into
 *   `vendorusers` in the target DB, updating vendorId to the new SP ID and
 *   stripping SL (PAPER) from commodities.
 *
 * Source DB : process.env.MONGO_URI            (defaults to .../fairdesk)
 * Target DB : process.env.SACHIKO_MONGO_URI    (defaults to source URI with
 *             the database name swapped to "sachiko")
 *
 * Usage:
 *   node scripts/migrate_sachiko_vendors.js           -- dry run (no writes)
 *   node scripts/migrate_sachiko_vendors.js --apply   -- write to DB
 */

import mongoose from "mongoose";
import { configDotenv } from "dotenv";

configDotenv({ quiet: true });

/** Swap the database name in a mongodb connection string. */
function withDbName(uri, dbName) {
  return uri.replace(
    /(\/\/[^/]+\/)([^?]*)(\?.*)?$/,
    (_m, pre, _db, query = "") => `${pre}${dbName}${query || ""}`,
  );
}

const SOURCE_URI =
  process.env.MONGO_URI || "mongodb://admin:YourStrongPassword@127.0.0.1:27017/fairdesk?authSource=admin";
const TARGET_URI = process.env.SACHIKO_MONGO_URI || withDbName(SOURCE_URI, "sachiko");

const SACHIKO_COMMODITIES = ["Adhesive", "Face paper", "Release paper", "Core"];
const EXCLUDE_COMMODITIES = ["SL (PAPER)"];

/* ── inline schema definitions ── */

const counterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  seq: { type: Number, required: true, default: 0 },
});

const vendorSchema = new mongoose.Schema({
  vendorId: String,
  vendorName: String,
  vendorStatus: String,
  hoLocation: String,
  warehouseLocation: String,
  commodities: [String],
  vendorGst: String,
  vendorMsme: String,
  vendorGumasta: String,
  vendorPan: String,
  vendorSignature: String,
  // binding to the vendor's users (what the app populates)
  users: [{ type: mongoose.Schema.Types.ObjectId, ref: "VendorUser" }],
  // tracking field for idempotency (only set on migrated docs)
  sourceVendorId: String,
});

const vendorUserSchema = new mongoose.Schema({
  vendorId: String,
  vendorName: String,
  hoLocation: String,
  warehouseLocation: String,
  userName: String,
  userLocation: String,
  userDepartment: String,
  userContact: String,
  userEmail: String,
  locationsCount: Number,
  locationDetails: [{ userLocation: String, dispatchAddress: String }],
  dispatchAddress: String,
  transportName: String,
  transportContact: String,
  dropLocation: String,
  dropLocation1: String,
  deliveryMode: String,
  deliveryLocation: String,
  deliveryLocation1: String,
  vendorPayment: String,
  SelfDispatch: String,
  vendorStatus: String,
  ownerName: String,
  ownerMobNo: String,
  ownerEmail: String,
  vendorGst: String,
  vendorMsme: String,
  commodities: [String],
  vendorUserSignature: String,
  // tracking fields for idempotency (only set on migrated docs)
  sourceVendorUserId: String,
  sourceVendorId: String,
});

/* ── helpers ── */

function padSeq(n) {
  return String(n).padStart(3, "0");
}

function hasSachikoCommodity(commodities) {
  if (!Array.isArray(commodities)) return false;
  return commodities.some((c) =>
    SACHIKO_COMMODITIES.some((sc) => String(c).trim().toLowerCase() === sc.toLowerCase()),
  );
}

function filterCommodities(commodities) {
  if (!Array.isArray(commodities)) return [];
  return commodities.filter(
    (c) => !EXCLUDE_COMMODITIES.some((ex) => String(c).trim().toLowerCase() === ex.toLowerCase()),
  );
}

/* ── main ── */

async function main() {
  const applyMode = process.argv.includes("--apply");

  console.log("\n  Sachiko Vendor Migration");
  console.log("  Mode:", applyMode ? "APPLY" : "DRY-RUN (pass --apply to write)");
  console.log("  Including commodities:", SACHIKO_COMMODITIES.join(", "));
  console.log("  Excluding commodities:", EXCLUDE_COMMODITIES.join(", "));
  console.log("  Source (read) :", SOURCE_URI);
  console.log("  Target (write):", TARGET_URI, "\n");

  const sourceConn = await mongoose.createConnection(SOURCE_URI).asPromise();
  const targetConn = await mongoose.createConnection(TARGET_URI).asPromise();
  console.log("  Connected.\n");

  // Source models (fairdesk DB)
  const Vendor = sourceConn.model("Vendor", vendorSchema, "vendors");
  const VendorUser = sourceConn.model("VendorUser", vendorUserSchema, "vendorusers");

  // Target models (sachiko DB) — standard collection names
  const TargetVendor = targetConn.model("Vendor", vendorSchema, "vendors");
  const TargetVendorUser = targetConn.model("VendorUser", vendorUserSchema, "vendorusers");
  const Counter = targetConn.model("Counter", counterSchema);

  async function nextVendorId() {
    const counter = await Counter.findOneAndUpdate(
      { key: "sachiko_vendorId" },
      { $inc: { seq: 1 } },
      { upsert: true, new: true },
    );
    let seq = counter.seq;
    while (await TargetVendor.exists({ vendorId: `SP | VENDOR | ${padSeq(seq)}` })) {
      seq += 1;
    }
    return `SP | VENDOR | ${padSeq(seq)}`;
  }

  const allVendors = await Vendor.find({}).lean();
  const matching = allVendors.filter((v) => hasSachikoCommodity(v.commodities));

  console.log(`  Total vendors in source collection : ${allVendors.length}`);
  console.log(`  Matching sachiko commodities       : ${matching.length}\n`);

  if (matching.length === 0) {
    console.log("  Nothing to migrate.");
    await sourceConn.close();
    await targetConn.close();
    process.exit(0);
  }

  let vendorsCreated = 0;
  let vendorsSkipped = 0;
  let coordinatorsCreated = 0;
  let coordinatorsSkipped = 0;

  for (const vendor of matching) {
    const existing = await TargetVendor.findOne({ sourceVendorId: vendor.vendorId }).lean();
    if (existing) {
      console.log(`  SKIP  "${vendor.vendorName}" — already in target vendors as ${existing.vendorId}`);
      vendorsSkipped++;

      // Still check for any coordinators not yet migrated
      const coordinators = await VendorUser.find({ vendorId: vendor.vendorId }).lean();
      for (const coord of coordinators) {
        const coordExisting = await TargetVendorUser.findOne({ sourceVendorUserId: String(coord._id) }).lean();
        if (coordExisting) {
          coordinatorsSkipped++;
        } else {
          console.log(`    COORDINATOR SKIP (vendor skipped, coord missing)  "${coord.userName}"`);
          coordinatorsSkipped++;
        }
      }
      continue;
    }

    const newId = applyMode ? await nextVendorId() : `SP | VENDOR | ${padSeq(vendorsCreated + 1)}`;
    const savedCommodities = filterCommodities(vendor.commodities);

    // Find coordinators for this vendor
    const coordinators = await VendorUser.find({ vendorId: vendor.vendorId }).lean();

    console.log(`  ${applyMode ? "CREATE" : "WOULD CREATE"}  "${vendor.vendorName}"`);
    console.log(`    Source ID    : ${vendor.vendorId}`);
    console.log(`    New ID       : ${newId}`);
    console.log(`    Commodities  : ${savedCommodities.join(", ")}`);
    console.log(`    Status       : ${vendor.vendorStatus}`);
    console.log(`    Location     : ${vendor.hoLocation}`);
    console.log(`    Coordinators : ${coordinators.length}`);

    // Create the coordinators first so we can collect their _ids and bind them
    // to the vendor via the `users` array (which is what the app populates).
    const createdUserIds = [];
    for (const coord of coordinators) {
      const coordExisting = await TargetVendorUser.findOne({ sourceVendorUserId: String(coord._id) }).lean();
      if (coordExisting) {
        console.log(`      SKIP coordinator "${coord.userName}" — already migrated`);
        createdUserIds.push(coordExisting._id);
        coordinatorsSkipped++;
        continue;
      }

      console.log(`      ${applyMode ? "CREATE" : "WOULD CREATE"} coordinator  "${coord.userName}"  (${coord.userLocation})`);

      if (applyMode) {
        const createdUser = await TargetVendorUser.create({
          vendorId: newId,
          vendorName: vendor.vendorName,
          hoLocation: coord.hoLocation,
          warehouseLocation: coord.warehouseLocation,
          userName: coord.userName,
          userLocation: coord.userLocation,
          userDepartment: coord.userDepartment,
          userContact: coord.userContact,
          userEmail: coord.userEmail,
          locationsCount: coord.locationsCount,
          locationDetails: coord.locationDetails || [],
          dispatchAddress: coord.dispatchAddress,
          transportName: coord.transportName,
          transportContact: coord.transportContact,
          dropLocation: coord.dropLocation,
          dropLocation1: coord.dropLocation1,
          deliveryMode: coord.deliveryMode,
          deliveryLocation: coord.deliveryLocation,
          deliveryLocation1: coord.deliveryLocation1,
          vendorPayment: coord.vendorPayment,
          SelfDispatch: coord.SelfDispatch,
          vendorStatus: coord.vendorStatus,
          ownerName: coord.ownerName,
          ownerMobNo: coord.ownerMobNo,
          ownerEmail: coord.ownerEmail,
          vendorGst: coord.vendorGst,
          vendorMsme: coord.vendorMsme,
          commodities: filterCommodities(coord.commodities),
          vendorUserSignature: coord.vendorUserSignature || undefined,
          sourceVendorUserId: String(coord._id),
          sourceVendorId: vendor.vendorId,
        });
        createdUserIds.push(createdUser._id);
      }
      coordinatorsCreated++;
    }

    if (applyMode) {
      await TargetVendor.create({
        vendorId: newId,
        vendorName: vendor.vendorName,
        vendorStatus: vendor.vendorStatus,
        hoLocation: vendor.hoLocation,
        warehouseLocation: vendor.warehouseLocation,
        commodities: savedCommodities,
        vendorGst: vendor.vendorGst,
        vendorMsme: vendor.vendorMsme,
        vendorGumasta: vendor.vendorGumasta,
        vendorPan: vendor.vendorPan,
        vendorSignature: vendor.vendorSignature || undefined,
        users: createdUserIds,
        sourceVendorId: vendor.vendorId,
      });
    }
    vendorsCreated++;
    console.log("");
  }

  console.log("  ─────────────────────────────────────");
  console.log(`  Vendors matched  : ${matching.length}`);
  console.log(`  Vendors skipped  : ${vendorsSkipped} (already migrated)`);
  console.log(`  Vendors ${applyMode ? "created " : "to create"} : ${vendorsCreated}`);
  console.log(`  Coords skipped   : ${coordinatorsSkipped} (already migrated)`);
  console.log(`  Coords ${applyMode ? "created  " : "to create"} : ${coordinatorsCreated}`);

  if (!applyMode && (vendorsCreated + coordinatorsCreated) > 0) {
    console.log("\n  Run with --apply to write these records to the database.");
  }

  await sourceConn.close();
  await targetConn.close();
  console.log("\n  Done.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});