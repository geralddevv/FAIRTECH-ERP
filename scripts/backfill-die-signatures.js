import mongoose from "mongoose";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import Die from "../models/utilities/die_model.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Backfills `dieSignature` on existing Die records (Die Master just gained a
 * duplicate-prevention signature — see routes/fairdesk_route.js's
 * buildDieSignature). The signature is spec-only (NOT dieDieNo/dieVersion)
 * so it catches the actual bug reported: the same physical die spec
 * re-entered under a brand-new Die No. It's deliberately not a unique DB
 * index — a "Replace"/"New Version" record is expected to share its
 * predecessor's signature, so this script also reports any signature that's
 * shared ACROSS different Die No lineages (a genuine duplicate) versus
 * within the same lineage (expected, not a duplicate).
 *
 * Idempotent: documents that already carry the correct signature are left
 * untouched. Dry-run by default; pass --apply to write.
 */

const APPLY = process.argv.includes("--apply");

function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}

const escapeRegExp = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rootDieNo = (dieNo) => String(dieNo || "").replace(/ \| [A-Z]$/, "");

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
  ].join("||");
}

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

  const dies = await Die.find({}).lean();
  const signatureMap = new Map(); // signature -> [{ dieDieNo, root }, ...]

  let updated = 0;
  const ops = [];

  for (const die of dies) {
    const signature = hashSignature(buildDieSignature(die));
    const root = rootDieNo(die.dieDieNo);
    if (!signatureMap.has(signature)) signatureMap.set(signature, []);
    signatureMap.get(signature).push({ dieDieNo: die.dieDieNo, root });

    if (die.dieSignature === signature) continue;
    updated += 1;
    console.log(`  ${die._id} (${die.dieDieNo}, V${die.dieVersion}) -> signature set`);
    if (APPLY) {
      ops.push({ updateOne: { filter: { _id: die._id }, update: { $set: { dieSignature: signature } } } });
    }
  }

  if (APPLY && ops.length) {
    await Die.collection.bulkWrite(ops, { ordered: false });
  }

  // Only a signature shared ACROSS different Die No lineages is a real
  // duplicate — sharing within one lineage (original + replace letters +
  // versions) is expected and not reported.
  const realDuplicates = [...signatureMap.entries()].filter(([, entries]) => {
    const roots = new Set(entries.map((e) => e.root));
    return roots.size > 1;
  });

  console.log("\n================ Summary ================");
  console.log(`Dies checked: ${dies.length}`);
  console.log(`${APPLY ? "Updated" : "Would update"}: ${updated}`);
  console.log(`Genuine duplicate groups found (same spec, different Die No lineage): ${realDuplicates.length}`);
  realDuplicates.forEach(([, entries]) =>
    console.log(`  ! duplicate: ${entries.map((e) => e.dieDieNo).join(", ")}`),
  );
  console.log("==========================================");
  console.log(APPLY ? "Done — changes written." : "Dry run complete — re-run with --apply to write these changes.");

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
