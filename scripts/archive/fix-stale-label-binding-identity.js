import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import Username from "../../models/users/username.js";
import { syncLabelBindingIdentity } from "../../utils/reconcileBindingLocations.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Label/ColorLabel bindings store a denormalized snapshot of
 * clientName/userName/userContact captured at creation time (see
 * models/inventory/labels.js, colorLabel.js). Editing a user's contact/name
 * afterward doesn't touch that snapshot, so pages that read straight off the
 * binding (e.g. /labels/view/:id) keep showing stale data — this is now kept
 * in sync going forward by syncLabelBindingIdentity, wired into POST
 * /form/edit/user/:userId in routes/fairdesk_route.js.
 *
 * This script runs that same sync once across every user with a Label or
 * ColorLabel binding, to catch drift that accumulated before that wiring
 * existed. Unlike location reconciliation there's no ambiguity here — the
 * live user record is always the single correct source — so every mismatch
 * found gets fixed.
 *
 * Idempotent: safe to re-run. Pass --apply to write; defaults to a dry run.
 */

const APPLY = process.argv.includes("--apply");

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

    const userIds = await Username.find({
      $or: [{ label: { $exists: true, $ne: [] } }, { colorLabel: { $exists: true, $ne: [] } }],
    })
      .select("_id")
      .lean();

    console.log(`Found ${userIds.length} user(s) with Label/ColorLabel bindings.\n`);

    let totalFixed = 0;

    for (const { _id: userId } of userIds) {
      const { fixed } = await syncLabelBindingIdentity(userId, { apply: APPLY });
      totalFixed += fixed.length;
      for (const f of fixed) {
        console.log(
          `  ${APPLY ? "Fixed" : "Would fix"} ${f.type} ${f.id}: ` +
            `"${f.from.clientName}" / "${f.from.userName}" / "${f.from.userContact}" -> ` +
            `"${f.to.clientName}" / "${f.to.userName}" / "${f.to.userContact}"`,
        );
      }
    }

    console.log("\n================ Summary ================");
    console.log(`${APPLY ? "Fixed" : "Would fix"}: ${totalFixed}`);
    console.log("==========================================");
    console.log(APPLY ? "Done — changes written." : "Dry run complete — re-run with --apply to write these changes.");

    process.exit(0);
  } catch (err) {
    console.error("Fix script failed:", err);
    process.exit(1);
  }
}

run();
