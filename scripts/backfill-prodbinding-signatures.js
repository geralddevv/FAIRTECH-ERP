import { fileURLToPath } from "url";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import ProductionBinding from "../models/utilities/productionBinding.js";

// ---------------------------------------------------------------------------
// One-time repair for Production Binding duplicate protection.
//
// The dup guard (routes/fairdesk_route.js) matches on prodSignature, and the
// unique index is SPARSE -- so bindings created before the signature system
// (no prodSignature) are invisible to both. Re-submitting the same
// client+user+location+label+die+block therefore inserts a fresh copy every
// time instead of being blocked (e.g. ZAVERI PEARLS ended up with 4 copies).
//
// This backfills a signature onto every unsigned binding. Where an unsigned
// binding's identity already belongs to a signed binding (or to a newer
// unsigned one processed here), it's a true duplicate and gets DELETED instead
// -- the unique index would reject a backfill anyway, and only one may survive.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-prodbinding-signatures.js          # preview
//   node scripts/backfill-prodbinding-signatures.js --apply  # commit
// ---------------------------------------------------------------------------

// These MUST stay identical to routes/fairdesk_route.js -- buildProdCalcSignature
// / normalizeProdCalcPart / hashSignature -- or the backfilled signatures won't
// match the ones the live route computes.
function normalizeProdCalcPart(value) {
  return String(value ?? "").trim().toUpperCase();
}
function buildProdCalcSignature(source) {
  return [
    normalizeProdCalcPart(source.companyName),
    normalizeProdCalcPart(source.userId),
    normalizeProdCalcPart(source.userLocation),
    normalizeProdCalcPart(source.labelProductId),
    normalizeProdCalcPart(source.dieId),
    normalizeProdCalcPart(source.blockId),
  ].join("||");
}
function hashSignature(raw) {
  return `sha256:${crypto.createHash("sha256").update(String(raw ?? "")).digest("hex")}`;
}

const APPLY = process.argv.includes("--apply");

await connectDB();

// Signatures already taken by SIGNED bindings -- an unsigned binding that hashes
// to one of these is a stale duplicate of an existing, protected record.
const signed = await ProductionBinding.find({ prodSignature: { $exists: true, $ne: null } })
  .select("_id prodSignature")
  .lean();
const takenSignatures = new Map(); // signature -> keeper _id
for (const s of signed) takenSignatures.set(s.prodSignature, String(s._id));

// Unsigned bindings, newest first -- so when several unsigned records share one
// identity and none is signed, the NEWEST is the one we keep (backfill).
const unsigned = await ProductionBinding.find({
  $or: [{ prodSignature: { $exists: false } }, { prodSignature: null }],
})
  .sort({ _id: -1 })
  .lean();

console.log(`Signed bindings:   ${signed.length}`);
console.log(`Unsigned bindings: ${unsigned.length}`);
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

let backfilled = 0;
let deleted = 0;

for (const d of unsigned) {
  const raw = buildProdCalcSignature(d);
  const sig = hashSignature(raw);
  const label = `${d.companyName || "?"} / ${d.userLocation || "?"} (_id ${d._id})`;

  if (takenSignatures.has(sig)) {
    // Identity already owned by a signed binding (or an earlier/newer unsigned
    // one we already chose to keep) -> this copy is redundant.
    const keeper = takenSignatures.get(sig);
    console.log(`DELETE   ${label}`);
    console.log(`           duplicate of ${keeper}  [${raw}]`);
    if (APPLY) await ProductionBinding.deleteOne({ _id: d._id });
    deleted++;
  } else {
    // First (newest) holder of this identity with no signed twin -> keep it and
    // stamp the signature. Claim the signature so later dupes resolve to this.
    takenSignatures.set(sig, String(d._id));
    console.log(`BACKFILL ${label}`);
    console.log(`           ${sig.slice(0, 24)}...  [${raw}]`);
    if (APPLY) await ProductionBinding.updateOne({ _id: d._id }, { $set: { prodSignature: sig } });
    backfilled++;
  }
}

console.log(`\n--- Summary ---`);
console.log(`Backfilled: ${backfilled}`);
console.log(`Deleted:    ${deleted}`);
console.log(APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit.");

await ProductionBinding.db.close();
process.exit(0);
