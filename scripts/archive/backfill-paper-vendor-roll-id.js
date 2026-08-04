import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import PaperStock from "../models/inventory/PaperStock.js";

// ---------------------------------------------------------------------------
// One-time backfill for PaperStock.vendorRollId.
//
// vendorRollId is new: it's the number the vendor themselves wrote on the
// roll, typed by the operator at inward, kept separately from this system's
// own generated rollId (see utils/rollId.js). It's a required field, so any
// reel that existed before it was added needs one filled in before it can be
// saved again (e.g. edited from the paper profile).
//
// For a reel that predates the rollId scheme entirely (migrated by
// scripts/backfill-paper-roll-ids.js), its rollId IS the vendor's original
// number -- that migration only renamed the field, it didn't change what the
// value meant. So this just copies rollId -> vendorRollId wherever
// vendorRollId is missing. A reel inwarded after both changes already has its
// own typed vendorRollId and is left alone.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-paper-vendor-roll-id.js           # preview
//   node scripts/backfill-paper-vendor-roll-id.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

await connectDB();

const reels = await PaperStock.find({
  $or: [{ vendorRollId: { $exists: false } }, { vendorRollId: "" }],
})
  .select("rollId location")
  .lean();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}`);
console.log(`Reels missing vendorRollId: ${reels.length}\n`);

for (const reel of reels) {
  console.log(`FILL     _id ${reel._id}${reel.location ? ` @ ${reel.location}` : ""}`);
  console.log(`           vendorRollId <- "${reel.rollId}"`);
  if (APPLY) {
    await PaperStock.updateOne({ _id: reel._id }, { $set: { vendorRollId: reel.rollId } });
  }
}

console.log(`\n${APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit."}`);

await PaperStock.db.close();
process.exit(0);
