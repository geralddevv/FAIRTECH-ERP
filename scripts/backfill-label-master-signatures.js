import mongoose from "mongoose";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import LabelMaster from "../models/inventory/labelMaster.js";
import ColorLabelMaster from "../models/inventory/colorLabelMaster.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Recomputes every LabelMaster / ColorLabelMaster's `labelSignature` under
 * the CURRENT buildLabelMasterSignature() formula (routes/fairdesk_route.js)
 * and rewrites it in place.
 *
 * Why: POST /form/label-master and /form/color-label-master only reject a
 * new master as a duplicate if its computed signature matches an EXISTING
 * master's *stored* labelSignature. That formula has changed shape several
 * times (fields added/removed), but existing masters never got their stored
 * value recomputed -- so a master created under an older formula version is
 * invisible to the duplicate check, letting an identical spec through.
 * Running this after any change to buildLabelMasterSignature() (or once now,
 * to clean up the backlog) keeps every master comparable so creation-time
 * dedup works against all of them, not just recently-created ones.
 *
 * Two masters that ALREADY hash identically under the current formula are a
 * real duplicate pair, not a stale-signature problem -- only one of them can
 * hold that signature (it's a unique field), so this script leaves the
 * other untouched and reports it. Use fix-duplicate-label-masters.js to
 * resolve those.
 *
 * Idempotent: safe to re-run. Pass --apply to write; defaults to a dry run.
 */

const APPLY = process.argv.includes("--apply");

function buildLabelMasterSignature(source) {
  return [
    String(source.jobType ?? "").trim().toUpperCase(),
    String(source.jobName ?? "").trim().toUpperCase(),
    String(source.instructions ?? "").trim().toUpperCase(),
    String(source.labelFamily ?? "").trim().toUpperCase(),
    String(source.labelWidth ?? "").trim(),
    String(source.labelHeight ?? "").trim(),
    String(source.labelGap ?? "").trim(),
    String(source.perRollQty ?? "").trim(),
    String(source.frontColor ?? "").trim(),
    String(source.backColor ?? "").trim(),
    String(source.varnish ?? "").trim().toUpperCase(),
    String(source.foilNo ?? "").trim(),
    String(source.firstOut ?? "").trim().toUpperCase(),
    String(source.paperType ?? "").trim().toUpperCase(),
    String(source.paperCode ?? "").trim().toUpperCase(),
  ].join("||");
}

function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}

async function backfillFamily(Model, familyName) {
  const masters = await Model.find({}).sort({ createdAt: 1 }).lean();

  let updated = 0;
  let alreadyCorrect = 0;
  let conflicts = 0;

  for (const master of masters) {
    const hashed = hashSignature(buildLabelMasterSignature(master));

    if (master.labelSignature === hashed) {
      alreadyCorrect++;
      continue;
    }

    // Someone else already legitimately owns the correctly-computed hash --
    // this is a real duplicate spec, not a stale-signature fix. Leave it for
    // fix-duplicate-label-masters.js.
    const holder = await Model.findOne({ labelSignature: hashed, _id: { $ne: master._id } })
      .select("labelProductId")
      .lean();
    if (holder) {
      console.log(
        `[${familyName}] ${master.labelProductId}: stale signature, but ${holder.labelProductId} already owns the ` +
          `correct hash (real duplicate spec) -- left untouched. Run fix-duplicate-label-masters.js to resolve.`,
      );
      conflicts++;
      continue;
    }

    console.log(`[${familyName}] ${master.labelProductId}: "${master.labelSignature || "(none)"}" -> "${hashed}"`);

    if (APPLY) {
      try {
        await Model.updateOne({ _id: master._id }, { $set: { labelSignature: hashed } });
        updated++;
      } catch (err) {
        if (err?.code === 11000) {
          console.log(`  -> CONFLICT on write (race with another update) -- left ${master.labelProductId} untouched.`);
          conflicts++;
          continue;
        }
        throw err;
      }
    } else {
      updated++;
    }
  }

  return { total: masters.length, updated, alreadyCorrect, conflicts };
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

  const plain = await backfillFamily(LabelMaster, "LABEL");
  const color = await backfillFamily(ColorLabelMaster, "COLOR");

  console.log("\n--- Summary ---");
  console.log(
    `Label masters:       total ${plain.total}, updated ${plain.updated}, already correct ${plain.alreadyCorrect}, conflicts ${plain.conflicts}`,
  );
  console.log(
    `Color label masters: total ${color.total}, updated ${color.updated}, already correct ${color.alreadyCorrect}, conflicts ${color.conflicts}`,
  );
  if (!APPLY && plain.updated + color.updated > 0) {
    console.log("\nRe-run with --apply to write these changes.");
  }
  if (plain.conflicts + color.conflicts > 0) {
    console.log(
      "\nSome masters were left unresolved because a real duplicate spec already exists -- run " +
        "fix-duplicate-label-masters.js (--apply) to resolve those, then re-run this script.",
    );
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
