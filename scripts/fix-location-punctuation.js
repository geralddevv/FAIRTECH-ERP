import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import Username from "../models/users/username.js";
import { normalizeLocationName } from "../utils/locations.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Backfill: strip stray leading/trailing commas/dots (e.g. "TARAPUR,", from
 * pasting a full address like "Tarapur, Maharashtra") from Username.userLocation
 * and Username.locationDetails[].userLocation.
 *
 * Item bindings (Label.location, ColorLabel.location, etc.) have always been
 * saved through a comma-stripping normalizer, but Username.locationDetails
 * was only trim+uppercased — so a polluted client location silently stopped
 * matching its own bindings on /master/view and /labels/view/:id, making
 * genuinely-bound items look unbound. See routes/fairdesk_route.js
 * normalizeLocationDetails() for the fix to the write path; this backfills
 * data saved before that fix.
 *
 * Idempotent: safe to re-run. Pass --apply to write; defaults to a dry run.
 */

const APPLY = process.argv.includes("--apply");

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

  const users = await Username.find({}).select("clientName userName userLocation locationDetails").lean();

  let touched = 0;
  for (const u of users) {
    const update = {};
    let changed = false;

    const cleanTop = normalizeLocationName(u.userLocation);
    if (cleanTop !== (u.userLocation || "")) {
      update.userLocation = cleanTop;
      changed = true;
    }

    const details = Array.isArray(u.locationDetails) ? u.locationDetails : [];
    let detailsChanged = false;
    const cleanDetails = details.map((d) => {
      const cleanLoc = normalizeLocationName(d.userLocation);
      if (cleanLoc !== (d.userLocation || "")) detailsChanged = true;
      return { ...d, userLocation: cleanLoc };
    });
    if (detailsChanged) {
      update.locationDetails = cleanDetails;
      changed = true;
    }

    if (!changed) continue;
    touched++;
    console.log(
      `  ${u.clientName || ""} / ${u.userName || u._id}: ` +
        `userLocation "${u.userLocation}" -> "${cleanTop}"` +
        (detailsChanged
          ? `; locationDetails[] userLocation ${JSON.stringify(details.map((d) => d.userLocation))} -> ${JSON.stringify(cleanDetails.map((d) => d.userLocation))}`
          : ""),
    );
    if (APPLY) {
      await Username.updateOne({ _id: u._id }, { $set: update });
    }
  }

  console.log(`\n${touched} user(s) with polluted location punctuation found.`);
  if (!APPLY && touched > 0) {
    console.log("Re-run with --apply to write these changes.");
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
