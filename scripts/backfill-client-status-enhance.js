import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import connectDB from "../config/db.js";
import Client from "../models/users/client.js";
import Username from "../models/users/username.js";

// ---------------------------------------------------------------------------
// One-time migration: clients currently marked FOLLOW UP move to the new
// ENHANCE status (/fairtech/client/view). Username carries its own copy of
// clientStatus (kept in sync by the client edit route), so it's updated too
// for every user belonging to a migrated client.
//
// Dry-run by default. Pass --apply to write changes.
//
//   node scripts/backfill-client-status-enhance.js          # preview
//   node scripts/backfill-client-status-enhance.js --apply  # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

await connectDB();

const clients = await Client.find({}, "clientId clientName clientStatus")
  .sort({ clientName: 1 })
  .lean();

const toMigrate = clients.filter((c) => String(c.clientStatus || "").trim().toUpperCase() === "FOLLOW UP");

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}`);
console.log(`Clients currently FOLLOW UP: ${toMigrate.length}\n`);

let migrated = 0;
let usersUpdated = 0;

for (const client of toMigrate) {
  console.log(`ENHANCE  ${client.clientName} [${client.clientId}] (_id ${client._id})`);
  if (APPLY) {
    await Client.updateOne({ _id: client._id }, { $set: { clientStatus: "ENHANCE" } });
    const result = await Username.updateMany({ clientId: client.clientId }, { $set: { clientStatus: "ENHANCE" } });
    usersUpdated += result.modifiedCount || 0;
  }
  migrated++;
}

console.log(`\n--- Summary ---`);
console.log(`Clients migrated: ${migrated}`);
console.log(`Usernames synced: ${APPLY ? usersUpdated : "(not counted in dry-run)"}`);
console.log(APPLY ? "Changes committed." : "Dry-run only. Re-run with --apply to commit.");

await Client.db.close();
process.exit(0);
