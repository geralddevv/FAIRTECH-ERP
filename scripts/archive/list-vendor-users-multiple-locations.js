import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import VendorUser from "../../models/users/vendorUser.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Lists every vendor user (coordinator) registered under more than one
 * location — i.e. VendorUser.locationDetails has more than one entry.
 * Read-only: just reports, never writes.
 */

function withAuth(uri) {
  const user = process.env.MONGO_USER;
  const pass = process.env.MONGO_PASS;
  if (user && pass && uri.startsWith("mongodb://") && !uri.includes("@")) {
    uri = uri.replace("mongodb://", `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`);
    if (!uri.includes("authSource")) uri += (uri.includes("?") ? "&" : "?") + "authSource=admin";
  }
  return uri;
}

async function run() {
  const uri = withAuth(process.env.MONGO_URI || "mongodb://localhost:27017/fairdesk");
  await mongoose.connect(uri);
  console.log("Database connected.\n");

  const vendorUsers = await VendorUser.find(
    {},
    "vendorId vendorName userName userLocation userDepartment locationDetails"
  )
    .sort({ vendorName: 1, userName: 1 })
    .lean();

  const multiLocation = vendorUsers.filter((u) => (u.locationDetails || []).length > 1);

  for (const u of multiLocation) {
    const locations = u.locationDetails.map((l) => l.userLocation || "(blank)").join(", ");
    console.log(`  ${u.vendorName} — ${u.userName} (${u.vendorId}): ${u.locationDetails.length} locations`);
    console.log(`    ${locations}`);
  }

  console.log("\n================ Summary ================");
  console.log(`Vendor users checked: ${vendorUsers.length}`);
  console.log(`Vendor users with multiple locations: ${multiLocation.length}`);
  console.log("==========================================");

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
