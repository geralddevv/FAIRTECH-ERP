import { fileURLToPath } from "url";
import path from "path";
import mongoose from "mongoose";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";

// ---------------------------------------------------------------------------
// One-time migration: PaperStock/PaperStockLog `rollNo` -> `rollId`.
//
// Paper reels are now identified by a system-generated Roll ID
// (ITEMCODE/YY-YY/NNN, e.g. C011/26-27/048 -- see utils/rollId.js) which is
// printed as a QR label, pasted on the physical reel and scanned at the job
// card to deduct that reel's running metres. That only works if the id names
// exactly one reel, so PaperStock.rollId carries a UNIQUE index -- whereas the
// vendor roll numbers it replaces were free text and legitimately repeated.
//
// So this does two things:
//   1. Renames the field on every PaperStock and PaperStockLog document.
//   2. Guarantees uniqueness on PaperStock. An existing roll no is kept as the
//      reel's id where it is non-empty and not already taken; the duplicates
//      (and the blanks) get a freshly generated ITEMCODE/YY-YY/NNN instead,
//      using today's financial year -- the same scheme and the same counter
//      (`paperRollId:C011:<YY-YY>`) new inwards use, so a re-run never
//      collides with what the app hands out after. Those reels are listed
//      individually below -- they are the ones whose paperwork no longer
//      matches their id, though in practice every reel already on the floor
//      needs a label printed for it anyway (paper profile -> Label).
//
// Log documents are left with whatever string they had: history is history, and
// nothing indexes or matches on it.
//
// >>> RUN THIS BEFORE STARTING THE APP ON THE NEW CODE. <<<
// The unique index cannot build while reels still have no rollId (they would
// all collide on null), and until it exists a scan has nothing to resolve.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-paper-roll-ids.js           # preview
//   node scripts/backfill-paper-roll-ids.js --apply   # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

// Kept in step with utils/rollId.js -- imported from there would pull in the
// PaperStock model, and touching the model is what triggers the index build
// this script exists to make possible.
const ITEM_CODE = "C011"; // TODO: derive per-paper once that mapping exists (see utils/rollId.js)
const normalizeRollId = (value) => String(value ?? "").trim().replace(/\s+/g, "").toUpperCase();
const two = (y) => String(y).slice(-2);
function financialYearLabel(date = new Date()) {
  const year = date.getFullYear();
  const startYear = date.getMonth() >= 3 ? year : year - 1; // getMonth() 3 = April
  return `${two(startYear)}-${two(startYear + 1)}`;
}
const rollCounterKey = (fy) => `paperRollId:${ITEM_CODE}:${fy}`;
const formatRollId = (fy, seq) => `${ITEM_CODE}/${fy}/${String(seq).padStart(3, "0")}`;

await connectDB();

// Raw collections throughout: the Mongoose models describe the post-migration
// shape, and using them here would both hide the old field and try to build the
// unique index before the data can satisfy it.
const stocks = mongoose.connection.collection("paperstocks");
const logs = mongoose.connection.collection("paperstocklogs");
const counters = mongoose.connection.collection("counters");

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

/* ---------------------------------------------------------------- PaperStock */

const fy = financialYearLabel();

// Oldest first, so where two reels claim the same roll no the one that has been
// on the floor longest keeps it and the newer arrival is the one relabelled.
const reels = await stocks.find({}).sort({ createdAt: 1, _id: 1 }).toArray();
console.log(`Paper stock reels: ${reels.length}`);

// Sequence cursor for the current year, seeded lazily from the same counter
// the live app increments -- so ids handed out here and ids handed out by the
// next inward never collide.
const key = rollCounterKey(fy);
let nextSeq;
async function nextGeneratedRollId() {
  if (nextSeq === undefined) {
    const counterDoc = await counters.findOne({ key });
    nextSeq = Number(counterDoc?.seq || 0);
  }
  let candidate;
  do {
    nextSeq += 1;
    candidate = formatRollId(fy, nextSeq);
  } while (taken.has(candidate));
  return candidate;
}

const taken = new Set();
let kept = 0;
let generated = 0;
let untouched = 0;

for (const reel of reels) {
  const existingId = normalizeRollId(reel.rollId);
  const legacyNo = normalizeRollId(reel.rollNo);
  const label = `_id ${reel._id}${reel.location ? ` @ ${reel.location}` : ""}`;

  // Already migrated and unique -- nothing to do (re-running is safe).
  if (existingId && !taken.has(existingId) && reel.rollNo === undefined) {
    taken.add(existingId);
    untouched++;
    continue;
  }

  const candidate = existingId || legacyNo;
  let rollId;

  if (candidate && !taken.has(candidate)) {
    rollId = candidate;
    kept++;
  } else {
    // Blank, or a roll no another reel already claimed.
    rollId = await nextGeneratedRollId();
    generated++;
    console.log(`NEW ID   ${label}`);
    console.log(`           ${candidate ? `"${candidate}" is already taken -> ` : "no roll no -> "}${rollId}  (print a label for this reel)`);
  }

  taken.add(rollId);
  if (APPLY) {
    await stocks.updateOne({ _id: reel._id }, { $set: { rollId }, $unset: { rollNo: "" } });
  }
}

// Park the counter past everything handed out here, so the next inward can't
// reissue an id that is already on a reel.
if (APPLY && nextSeq !== undefined) {
  await counters.updateOne({ key }, { $set: { seq: nextSeq }, $setOnInsert: { key } }, { upsert: true });
}

/* ------------------------------------------------------------- PaperStockLog */

const logsToRename = await logs.countDocuments({ rollNo: { $exists: true } });
console.log(`\nStock log lines carrying rollNo: ${logsToRename}`);
if (APPLY && logsToRename > 0) {
  await logs.updateMany({ rollNo: { $exists: true } }, { $rename: { rollNo: "rollId" } });
}

/* -------------------------------------------------------------------- Report */

console.log(`\n--- Summary ---`);
console.log(`Kept existing id:  ${kept}`);
console.log(`Newly generated:   ${generated}${generated ? "  <- these reels need a label printed" : ""}`);
console.log(`Already migrated:  ${untouched}`);
console.log(`Log lines renamed: ${APPLY ? logsToRename : `${logsToRename} (would be)`}`);
console.log(
  APPLY
    ? "\nChanges committed. Start the app to let the unique rollId index build."
    : "\nDry-run only. Re-run with --apply to commit.",
);

await mongoose.connection.close();
process.exit(0);
