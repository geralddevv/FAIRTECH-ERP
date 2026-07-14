import mongoose from "mongoose";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import Client from "../models/users/client.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Backfills/recomputes `clientSignature` on existing Client records, using
 * the same buildClientSignature() shape as routes/users/clients.js and
 * routes/fairdesk_route.js (clientName/clientType/clientStatus/hoLocation/
 * accountHead/clientGst/clientMsme/clientGumasta/clientPan — vendorCode is
 * deliberately excluded, it's not part of a client's logical identity).
 * Run this after any change to that field list, or to repair signatures left
 * stale/missing by older code paths.
 *
 * Idempotent: documents that already carry the correct signature are left
 * untouched. Dry-run by default; pass --apply to write.
 */

const APPLY = process.argv.includes("--apply");

function hashSignature(rawSignature) {
  return `sha256:${crypto.createHash("sha256").update(String(rawSignature ?? "")).digest("hex")}`;
}

function normalizeClientPart(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function buildClientSignature(source) {
  return [
    normalizeClientPart(source.clientName),
    normalizeClientPart(source.clientType),
    normalizeClientPart(source.clientStatus),
    normalizeClientPart(source.hoLocation),
    normalizeClientPart(source.accountHead),
    normalizeClientPart(source.clientGst),
    normalizeClientPart(source.clientMsme),
    normalizeClientPart(source.clientGumasta),
    normalizeClientPart(source.clientPan),
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

  const clients = await Client.find({}).lean();
  const signatureMap = new Map(); // signature -> [clientId, ...]

  let updated = 0;
  const ops = [];

  for (const client of clients) {
    const signature = hashSignature(buildClientSignature(client));

    if (!signatureMap.has(signature)) signatureMap.set(signature, []);
    signatureMap.get(signature).push(client.clientId);

    if (client.clientSignature === signature) continue;
    updated += 1;
    console.log(`  ${client._id} (${client.clientId}) -> signature ${client.clientSignature ? "recomputed" : "set"}`);
    if (APPLY) {
      ops.push({ updateOne: { filter: { _id: client._id }, update: { $set: { clientSignature: signature } } } });
    }
  }

  if (APPLY && ops.length) {
    await Client.collection.bulkWrite(ops, { ordered: false });
  }

  const duplicates = [...signatureMap.entries()].filter(([, ids]) => ids.length > 1);

  console.log("\n================ Summary ================");
  console.log(`Clients checked: ${clients.length}`);
  console.log(`${APPLY ? "Updated" : "Would update"}: ${updated}`);
  console.log(`Duplicate groups found (same signature, different clients): ${duplicates.length}`);
  duplicates.forEach(([, ids]) => console.log(`  ! duplicate: ${ids.join(", ")}`));
  console.log("==========================================");
  console.log(APPLY ? "Done — changes written." : "Dry run complete — re-run with --apply to write these changes.");

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
