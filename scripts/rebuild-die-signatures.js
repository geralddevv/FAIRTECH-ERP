import { fileURLToPath } from "url";
import path from "path";
import crypto from "crypto";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import Die from "../models/utilities/die_model.js";

// ---------------------------------------------------------------------------
// Repair for Die Master duplicate protection.
//
// A die's identity is its physical spec (type/make/blade/machine no/family/
// dimensions/etc) PLUS its dieFlatRemark, deliberately excluding the
// generated Die No/version -- see the comment above buildDieSignature in
// routes/fairdesk_route.js. dieFlatRemark joined the identity after dies
// already existed, so their stored dieSignature was computed under the older
// formula and needs this rebuild before the duplicate check (which compares
// dieSignature) can tell them apart correctly.
//
// Unlike Paper Master, dieSignature carries no unique index -- a "Replace"/
// "New Version" record is EXPECTED to share its predecessor's signature, and
// the create/edit routes enforce uniqueness themselves by excluding the die's
// own lineage (lineageDieIds) before comparing. So this script only ever
// recomputes and writes each die's own signature; it never needs to merge or
// clear anyone else's.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/rebuild-die-signatures.js          # preview
//   node scripts/rebuild-die-signatures.js --apply  # commit
// ---------------------------------------------------------------------------

// These MUST stay identical to buildDieSignature / normalizeDiePart /
// normalizeDieList / hashSignature in routes/fairdesk_route.js, or the
// rebuilt signatures won't match what the live routes compute.
function normalizeDiePart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim().toUpperCase();
}
function normalizeDieList(value) {
  const arr = Array.isArray(value) ? value : value ? [value] : [];
  return arr.map((v) => normalizeDiePart(v)).filter(Boolean).sort().join(",");
}
function buildDieSignature(source) {
  return [
    normalizeDiePart(source.dieType),
    normalizeDiePart(source.dieMake),
    normalizeDiePart(source.dieBladType),
    normalizeDieList(source.dieMachineNo),
    normalizeDieList(source.dieFamily),
    normalizeDiePart(source.dieTeeth),
    normalizeDiePart(source.dieWidth),
    normalizeDiePart(source.dieHeight),
    normalizeDiePart(source.dieActualWidth),
    normalizeDiePart(source.dieActualHeight),
    normalizeDiePart(source.dieActualRepGap),
    normalizeDiePart(source.dieFlatAcrossGap),
    normalizeDiePart(source.dieFlatrepGap),
    normalizeDiePart(source.dieFlatAcross),
    normalizeDiePart(source.dieFlatDown),
    normalizeDiePart(source.dieTotalUps),
    normalizeDiePart(source.diePapType),
    normalizeDiePart(source.dieOwnedBy),
    normalizeDiePart(source.dieClientName),
    normalizeDiePart(source.dieFlatRemark),
  ].join("||");
}
function hashSignature(raw) {
  return `sha256:${crypto.createHash("sha256").update(String(raw ?? "")).digest("hex")}`;
}

const APPLY = process.argv.includes("--apply");

await connectDB();

const dies = await Die.find()
  .select(
    "dieDieNo dieType dieMake dieBladType dieMachineNo dieFamily dieTeeth dieWidth dieHeight " +
      "dieActualWidth dieActualHeight dieActualRepGap dieFlatAcrossGap dieFlatrepGap dieFlatAcross " +
      "dieFlatDown dieTotalUps diePapType dieOwnedBy dieClientName dieFlatRemark dieSignature",
  )
  .sort({ dieDieNo: 1, _id: 1 })
  .lean();

console.log(`Dies: ${dies.length}`);
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

const label = (die) => `${die.dieDieNo || "?"} (_id ${die._id})`;

const toRebuild = [];
let unchanged = 0;

for (const die of dies) {
  const raw = buildDieSignature(die);
  const signature = hashSignature(raw);
  if (die.dieSignature === signature) {
    unchanged++;
    continue;
  }
  toRebuild.push({ die, signature, raw });
}

for (const { die, signature, raw } of toRebuild) {
  const was = die.dieSignature ? `${die.dieSignature.slice(0, 24)}...` : "(none)";
  console.log(`REBUILD  ${label(die)}`);
  console.log(`           ${was} -> ${signature.slice(0, 24)}...  [${raw}]`);
}

if (APPLY) {
  for (const { die, signature } of toRebuild) {
    await Die.updateOne({ _id: die._id }, { $set: { dieSignature: signature } });
  }
}

console.log(`\n--- Summary ---`);
console.log(`Rebuilt:        ${toRebuild.length}`);
console.log(`Already correct:${unchanged}`);
console.log(APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit.");

await Die.db.close();
process.exit(0);
