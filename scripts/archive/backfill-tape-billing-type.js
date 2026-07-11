import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import TapeBinding from "../../models/inventory/tapeBinding.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Backfill `billingType` on existing TapeBinding records to "ROLLS", since
 * every binding created before this field existed was implicitly billed by
 * the roll (tapeRatePerRoll). New bindings choose Rolls / Running Mtrs on
 * the form going forward.
 *
 * Idempotent: safe to re-run. Pass --apply to write; defaults to a dry run.
 */

const APPLY = process.argv.includes("--apply");

async function run() {
  let uri = process.env.MONGO_URI || "mongodb://localhost:27017/fairdesk";
  const user = process.env.MONGO_USER;
  const pass = process.env.MONGO_PASS;
  if (user && pass && uri.startsWith("mongodb://") && !uri.includes("@")) {
    uri = uri.replace("mongodb://", `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`);
    if (!uri.includes("authSource")) uri += (uri.includes("?") ? "&" : "?") + "authSource=admin";
  }
  await mongoose.connect(uri);
  console.log(`Database connected.${APPLY ? "" : "  (DRY RUN — pass --apply to write changes)"}\n`);

  const bindings = await TapeBinding.find({
    $or: [{ billingType: { $exists: false } }, { billingType: null }],
  })
    .select("tapeClientPaperCode billingType")
    .lean();

  console.log(`Found ${bindings.length} tape binding(s) missing billingType.`);

  for (const b of bindings) {
    console.log(`  ${b.tapeClientPaperCode || b._id}: billingType -> "ROLLS"`);
    if (APPLY) {
      await TapeBinding.updateOne({ _id: b._id }, { $set: { billingType: "ROLLS" } });
    }
  }

  if (!APPLY && bindings.length > 0) {
    console.log("\nRe-run with --apply to write these changes.");
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
