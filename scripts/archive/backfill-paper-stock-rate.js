import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import PaperStock from "../models/inventory/PaperStock.js";
import PaperStockLog from "../models/inventory/PaperStockLog.js";
import Paper from "../models/inventory/paper.js";

// ---------------------------------------------------------------------------
// One-time backfill for PaperStock.rate / PaperStockLog.rate.
//
// rate is new: each reel now remembers what it was actually bought at (so a
// reel inwarded today at ₹20 stays distinct from one inwarded tomorrow at
// ₹25), rather than relying on the Paper master's rate, which only ever holds
// the current/previous/lowest rate across every reel of that paper. It's
// required on PaperStock, so any reel that existed before it was added needs
// one filled in before it can be saved again (e.g. edited from the paper
// profile) -- required-field validation runs against the whole document on
// save, not just the fields actually being changed.
//
// There's no record of what these older reels were actually bought at, so
// they're backfilled with the paper's current rate as the closest available
// stand-in. PaperStockLog.rate is optional (some log lines legitimately span
// several reels at once, see routes/fairdesk_route.js's logPaperStockChange),
// so only INWARD/OUTWARD lines that clearly belong to one reel (they carry a
// rollId) get backfilled, from that reel's own rate once it's set.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-paper-stock-rate.js           # preview
//   node scripts/backfill-paper-stock-rate.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

await connectDB();

const reels = await PaperStock.find({ rate: { $exists: false } })
  .select("rollId paper")
  .lean();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}`);
console.log(`Reels missing rate: ${reels.length}\n`);

const paperIds = [...new Set(reels.map((r) => String(r.paper)))];
const papers = await Paper.find({ _id: { $in: paperIds } }).select("rate").lean();
const rateByPaper = new Map(papers.map((p) => [String(p._id), p.rate]));

const rateByRollId = new Map();

for (const reel of reels) {
  const rate = rateByPaper.get(String(reel.paper));
  if (rate == null) {
    console.log(`SKIP     ${reel.rollId} (_id ${reel._id}) -- paper master has no rate either`);
    continue;
  }
  console.log(`FILL     ${reel.rollId} (_id ${reel._id})`);
  console.log(`           rate <- ${rate}`);
  if (reel.rollId) rateByRollId.set(reel.rollId, rate);
  if (APPLY) {
    await PaperStock.updateOne({ _id: reel._id }, { $set: { rate } });
  }
}

if (rateByRollId.size) {
  const logs = await PaperStockLog.find({
    rate: { $exists: false },
    rollId: { $in: [...rateByRollId.keys()] },
  })
    .select("rollId type")
    .lean();

  console.log(`\nLog lines missing rate (matched by rollId): ${logs.length}\n`);
  for (const log of logs) {
    const rate = rateByRollId.get(log.rollId);
    console.log(`FILL     log _id ${log._id} (${log.type} ${log.rollId})`);
    console.log(`           rate <- ${rate}`);
    if (APPLY) {
      await PaperStockLog.updateOne({ _id: log._id }, { $set: { rate } });
    }
  }
}

console.log(`\n${APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit."}`);

await PaperStock.db.close();
process.exit(0);
