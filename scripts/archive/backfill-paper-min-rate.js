import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import Paper from "../models/inventory/paper.js";

// ---------------------------------------------------------------------------
// One-time backfill for Paper.minRate.
//
// minRate ("Lowest" on the Paper Master table at /fairtech/paper/view) is
// new: the lowest rate ever recorded for that paper. Paper Stock inward and
// the Paper Master edit dialog both keep it up to date going forward (see
// bumpPaperRate in routes/stock/paperStock.js and the PUT /paper/:id handler
// in routes/fairdesk_route.js), but papers created before this field existed
// have no minRate yet -- for those, the current rate is the only rate on
// record, so it's also the lowest one on record.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-paper-min-rate.js           # preview
//   node scripts/backfill-paper-min-rate.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

await connectDB();

const papers = await Paper.find({ minRate: { $exists: false } })
  .select("paperProductId rate")
  .lean();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}`);
console.log(`Papers missing minRate: ${papers.length}\n`);

for (const paper of papers) {
  console.log(`FILL     ${paper.paperProductId} (_id ${paper._id})`);
  console.log(`           minRate <- ${paper.rate}`);
  if (APPLY) {
    await Paper.updateOne({ _id: paper._id }, { $set: { minRate: paper.rate } });
  }
}

console.log(`\n${APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit."}`);

await Paper.db.close();
process.exit(0);
