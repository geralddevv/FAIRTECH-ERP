import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import Label from "../models/inventory/labels.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Lists every client label binding (created via /fairtech/form/labels) whose
 * MOQ is still stored in ROLLS. The create form no longer offers a Rolls
 * option -- MOQ is always entered in labels going forward -- so this is a
 * read-only report of the existing bindings that predate that change, for
 * review/manual follow-up.
 *
 * Read-only: makes no changes.
 */

async function run() {
  let uri = process.env.MONGO_URI || "mongodb://localhost:27017/fairdesk";
  const user = process.env.MONGO_USER;
  const pass = process.env.MONGO_PASS;
  if (user && pass && uri.startsWith("mongodb://") && !uri.includes("@")) {
    uri = uri.replace("mongodb://", `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`);
    if (!uri.includes("authSource")) uri += (uri.includes("?") ? "&" : "?") + "authSource=admin";
  }
  await mongoose.connect(uri);
  console.log("Database connected.\n");

  const bindings = await Label.find({ moqUnit: "ROLLS" })
    .select(
      "clientName userName userContact location productId jobType labelWidth labelHeight minOrderQty perRollQty status",
    )
    .sort({ clientName: 1, userName: 1 })
    .lean();

  if (!bindings.length) {
    console.log("No label bindings found with MOQ in Rolls.");
  } else {
    const byClient = {};
    for (const b of bindings) {
      (byClient[b.clientName || "(unknown client)"] ||= []).push(b);
    }

    for (const [clientName, items] of Object.entries(byClient)) {
      console.log(`\n${clientName} (${items.length})`);
      for (const b of items) {
        console.log(
          `  - ${b.userName || "(unknown user)"} @ ${b.location || "?"} | ${b.productId} | ${b.jobType} ` +
            `${b.labelWidth || "?"}x${b.labelHeight || "?"} | MOQ ${b.minOrderQty || 0} rolls ` +
            `(${b.perRollQty || "?"} labels/roll) | status: ${b.status || "ACTIVE"}`,
        );
      }
    }
  }

  console.log(`\n--- Summary ---`);
  console.log(`Total bindings with MOQ in Rolls: ${bindings.length}`);
  console.log(`Distinct clients affected: ${new Set(bindings.map((b) => b.clientName)).size}`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
