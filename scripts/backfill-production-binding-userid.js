import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import ProductionBinding from "../models/utilities/productionBinding.js";
import Username from "../models/users/username.js";
import { escapeRegex } from "../utils/security.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Production Binding entries created before the userId reference existed
 * (see models/utilities/productionBinding.js, and the entries migrated from
 * the old shared `calculators` collection by
 * scripts/migrate-calculators-to-production-binding.js) only carry a
 * denormalized snapshot of companyName/userName/userContact/userLocation,
 * captured at save time. GET /prodcalc/view now prefers live data populated
 * from userId, falling back to that snapshot only when userId is missing.
 *
 * This script backfills userId on those older entries by matching their
 * companyName/userName against the live Username collection (clientName +
 * userName, narrowed by userLocation when a name is ambiguous at that
 * client), and refreshes the snapshot fields to match the live record it
 * found — so both the (new) live path and the (fallback) snapshot path show
 * current data.
 *
 * Entries where the match is missing or ambiguous are left untouched and
 * reported for manual review — guessing wrong here would silently attach a
 * binding to the wrong client's user.
 *
 * Idempotent: safe to re-run — entries that already have userId are skipped.
 * Pass --apply to write; defaults to a dry run.
 */

const APPLY = process.argv.includes("--apply");

function norm(v) {
  return String(v ?? "").trim();
}

async function findLiveUser(entry) {
  const clientName = norm(entry.companyName);
  const userName = norm(entry.userName);
  if (!clientName || !userName) return { match: null, reason: "missing companyName/userName on the entry" };

  const candidates = await Username.find({
    clientName: new RegExp(`^${escapeRegex(clientName)}$`, "i"),
    userName: new RegExp(`^${escapeRegex(userName)}$`, "i"),
  }).lean();

  if (!candidates.length) return { match: null, reason: "no matching user found" };
  if (candidates.length === 1) return { match: candidates[0], reason: null };

  // Multiple users with the same name at the same client — narrow by location.
  const entryLoc = norm(entry.userLocation).toUpperCase();
  const byLocation = candidates.filter((u) => {
    if (norm(u.userLocation).toUpperCase() === entryLoc) return true;
    return (u.locationDetails || []).some((ld) => norm(ld.userLocation).toUpperCase() === entryLoc);
  });

  if (byLocation.length === 1) return { match: byLocation[0], reason: null };
  return { match: null, reason: `ambiguous — ${candidates.length} users named "${userName}" at "${clientName}"` };
}

async function run() {
  try {
    let uri = process.env.MONGO_URI || "mongodb://localhost:27017/fairdesk";
    const user = process.env.MONGO_USER;
    const pass = process.env.MONGO_PASS;
    if (user && pass && uri.startsWith("mongodb://") && !uri.includes("@")) {
      uri = uri.replace("mongodb://", `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`);
      if (!uri.includes("authSource")) uri += (uri.includes("?") ? "&" : "?") + "authSource=admin";
    }
    await mongoose.connect(uri);
    console.log(`Database connected.${APPLY ? "" : "  (DRY RUN — pass --apply to write changes)"}\n`);

    const entries = await ProductionBinding.find({ userId: { $exists: false } }).lean();
    console.log(`Found ${entries.length} production binding entr${entries.length === 1 ? "y" : "ies"} without a live userId.\n`);

    let fixed = 0;
    let unmatched = 0;

    for (const entry of entries) {
      const { match, reason } = await findLiveUser(entry);

      if (!match) {
        unmatched += 1;
        console.log(`  SKIP ${entry._id} (${entry.companyName || ""} / ${entry.userName || ""}): ${reason}`);
        continue;
      }

      const changes = [];
      if (norm(entry.userName) !== match.userName) changes.push(`userName "${entry.userName || ""}" -> "${match.userName}"`);
      if (norm(entry.userContact) !== match.userContact) changes.push(`userContact "${entry.userContact || ""}" -> "${match.userContact}"`);
      if (norm(entry.companyName) !== match.clientName) changes.push(`companyName "${entry.companyName || ""}" -> "${match.clientName}"`);

      console.log(
        `  ${APPLY ? "Fixing" : "Would fix"} ${entry._id}: linking to user ${match._id} (${match.clientName} / ${match.userName})` +
          (changes.length ? ` — ${changes.join(", ")}` : ""),
      );

      fixed += 1;
      if (APPLY) {
        await ProductionBinding.updateOne(
          { _id: entry._id },
          {
            $set: {
              userId: match._id,
              userName: match.userName,
              userContact: match.userContact,
              companyName: match.clientName,
            },
          },
        );
      }
    }

    console.log("\n================ Summary ================");
    console.log(`Total entries missing userId: ${entries.length}`);
    console.log(`${APPLY ? "Fixed" : "Would fix"}: ${fixed}`);
    console.log(`Unmatched (left untouched): ${unmatched}`);
    console.log("==========================================");
    console.log(APPLY ? "Done — changes written." : "Dry run complete — re-run with --apply to write these changes.");

    process.exit(0);
  } catch (err) {
    console.error("Backfill script failed:", err);
    process.exit(1);
  }
}

run();
