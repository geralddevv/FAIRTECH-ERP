import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import PaperStock from "../models/inventory/PaperStock.js";

// ---------------------------------------------------------------------------
// One-time backfill for PaperStock.invoiceNo.
//
// invoiceNo is new (the batch inward form at /fairtech/paperstock now asks
// for the vendor's invoice up front, shared across every roll from that
// delivery). It's a required field, so any reel that existed before it was
// added needs one filled in before it can be saved again (e.g. edited from
// the paper profile) -- required-field validation runs against the whole
// document on save, not just the fields actually being changed.
//
// There's no real invoice number to recover for these older reels, so they
// get a clearly-marked placeholder ("LEGACY") rather than a guess.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-paper-invoice-no.js           # preview
//   node scripts/backfill-paper-invoice-no.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");
const PLACEHOLDER = "LEGACY";

await connectDB();

const reels = await PaperStock.find({
  $or: [{ invoiceNo: { $exists: false } }, { invoiceNo: "" }],
})
  .select("rollId location")
  .lean();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}`);
console.log(`Reels missing invoiceNo: ${reels.length}\n`);

for (const reel of reels) {
  console.log(`FILL     _id ${reel._id}${reel.location ? ` @ ${reel.location}` : ""} (roll ${reel.rollId})`);
  console.log(`           invoiceNo <- "${PLACEHOLDER}"`);
  if (APPLY) {
    await PaperStock.updateOne({ _id: reel._id }, { $set: { invoiceNo: PLACEHOLDER } });
  }
}

console.log(`\n${APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit."}`);

await PaperStock.db.close();
process.exit(0);
