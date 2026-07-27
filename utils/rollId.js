import Counter from "../models/system/counter.js";
import PaperStock from "../models/inventory/PaperStock.js";

// ---------------------------------------------------------------------------
// Paper reel identity.
//
// Every reel inwarded at /fairtech/paperstock is given a Roll ID here, printed
// as a QR label and pasted on the physical roll. The job card's Roll ID field
// is filled by scanning that label, and the metres run against it are deducted
// from exactly that reel -- so the id has to be unique.
//
// Format: ITEMCODE/YY-YY/NNN -- e.g. C011/26-27/048. ITEMCODE is the paper's
// own Prod Code (uppercased), YY-YY is the financial year the reel was
// inwarded in (April-March), and NNN is a sequence number scoped to that
// item+year (so it starts fresh each financial year rather than climbing
// forever, and a slow-moving item doesn't inherit a fast-moving one's high
// numbers). This is FAIRTECH's own convention for numbering a roll on
// arrival, not something printed on it by the vendor -- generated here rather
// than typed so the year part can never be mistyped and the sequence can
// never repeat.
// ---------------------------------------------------------------------------

export const ROLL_ID_RE = /^[A-Z0-9]+\/\d{2}-\d{2}\/\d{3,}$/;

const normalizeItemCode = (value) => String(value ?? "").trim().toUpperCase();

// Indian financial year, April-March. Evaluated at generation time -- a reel
// inwarded on the last day of March and one inwarded the next day get
// different years, same as the paperwork would.
export function financialYearLabel(date = new Date()) {
  const year = date.getFullYear();
  const startYear = date.getMonth() >= 3 ? year : year - 1; // getMonth() 3 = April
  const two = (y) => String(y).slice(-2);
  return `${two(startYear)}-${two(startYear + 1)}`;
}

// One counter per item code per financial year, so the sequence resets each
// year -- and starts fresh for each item -- instead of climbing forever
// shared across every paper.
const rollCounterKey = (itemCode, fy) => `paperRollId:${itemCode}:${fy}`;

export const formatRollId = (itemCode, fy, seq) => `${itemCode}/${fy}/${String(seq).padStart(3, "0")}`;

// Scanners pad with stray whitespace and some are configured for lower case;
// the stored (and compared) form is upper case with no spaces.
export const normalizeRollId = (value) => String(value ?? "").trim().replace(/\s+/g, "").toUpperCase();

// The QR on the label doesn't carry the Roll ID alone -- its payload is
// "rollId vendorRollId paperSize paperMtrs" (see utils/rollLabelPrn.js), so a
// scan into a Roll ID box arrives as that whole space-separated string. The
// Roll ID is always the first token; this pulls just that out and normalizes
// it, so matching still works whether the box holds a full scan or someone
// typed/picked a bare roll id by hand. Must stay in step with the client copy
// in views/inventory/masters/jobCardForm.ejs.
export const extractScannedRollId = (value) => normalizeRollId(String(value ?? "").trim().split(/\s+/)[0] || "");

// Claims the next sequence number for this item code's current financial
// year. The counter only ever moves forward, but reels that predate this
// scheme (or a prior numbering scheme) keep whatever id they already had (see
// scripts/backfill-paper-roll-ids.js), so a generated id is still checked
// against stock before it is handed out.
export async function generateRollId(itemCodeRaw) {
  const itemCode = normalizeItemCode(itemCodeRaw);
  if (!itemCode) throw new Error("A Prod Code is required to generate a roll id");

  const fy = financialYearLabel();
  const key = rollCounterKey(itemCode, fy);

  for (let attempt = 0; attempt < 10000; attempt++) {
    const counter = await Counter.findOneAndUpdate(
      { key },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    const candidate = formatRollId(itemCode, fy, counter.seq);
    if (!(await PaperStock.exists({ rollId: candidate }))) return candidate;
  }
  throw new Error("Unable to generate a unique roll id");
}

// What the next reel for this item code would be called, without consuming a
// sequence number -- the inward form shows it in the (read-only) Roll ID
// field as soon as Prod Code is picked, so the operator knows what is about
// to print. Empty item code (nothing picked yet) previews as "".
export async function previewRollId(itemCodeRaw) {
  const itemCode = normalizeItemCode(itemCodeRaw);
  if (!itemCode) return "";

  const fy = financialYearLabel();
  const key = rollCounterKey(itemCode, fy);
  const counter = await Counter.findOne({ key }).select("seq").lean();
  return formatRollId(itemCode, fy, Number(counter?.seq || 0) + 1);
}
