import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import SimCard from "../../models/hr/simcard_model.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * The "Unassigned" placeholder SIM card employeeName used to be created with
 * mixed case ("Unassigned"). New records are created as "UNASSIGNED" to
 * match the rest of the app's all-caps naming convention; this backfills
 * existing rows to match.
 *
 * Idempotent: safe to re-run. Pass --apply to write; defaults to a dry run.
 */

const APPLY = process.argv.includes("--apply");

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

  const stale = await SimCard.find(
    { isUnassigned: true, employeeName: { $ne: "UNASSIGNED" } },
    "employeeName mobileNumber"
  ).lean();

  for (const s of stale) {
    console.log(`  ${s._id} (${s.mobileNumber}): "${s.employeeName}" -> "UNASSIGNED"`);
  }

  if (APPLY && stale.length) {
    await SimCard.updateMany(
      { isUnassigned: true, employeeName: { $ne: "UNASSIGNED" } },
      { $set: { employeeName: "UNASSIGNED" } }
    );
  }

  console.log("\n================ Summary ================");
  console.log(`${APPLY ? "Updated" : "Would update"}: ${stale.length}`);
  console.log("==========================================");
  console.log(APPLY ? "Done — changes written." : "Dry run complete — re-run with --apply to write these changes.");

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
