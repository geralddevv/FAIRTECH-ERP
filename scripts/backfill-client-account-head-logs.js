import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import Client from "../models/users/client.js";
import ClientAccountHeadLog from "../models/users/ClientAccountHeadLog.js";

// ---------------------------------------------------------------------------
// Seeds a starting ClientAccountHeadLog ("SET") for every Client Master
// record that predates the Account Head history feature (routes/users/
// clients.js POST /edit/:id, routes/fairdesk_route.js POST /form/client) --
// otherwise their /fairtech/client/profile/:id page shows an empty history
// table until the account head is next changed.
//
// Only touches clients with zero existing ClientAccountHeadLog rows, so it's
// safe to re-run -- clients that already have history (created after this
// feature shipped, or already backfilled) are left alone.
//
// Dry-run by default -- pass --apply to commit.
//
//   node scripts/backfill-client-account-head-logs.js            # preview
//   node scripts/backfill-client-account-head-logs.js --apply    # commit
// ---------------------------------------------------------------------------

const APPLY = process.argv.includes("--apply");

await connectDB();

console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}\n`);

const loggedClientIds = new Set((await ClientAccountHeadLog.distinct("clientId")).map(String));
const clients = await Client.find({}, "clientName accountHead").lean();

const missing = clients.filter((c) => !loggedClientIds.has(String(c._id)));

console.log(`Clients total: ${clients.length}`);
console.log(`Already have history: ${clients.length - missing.length}`);
console.log(`Missing initial log: ${missing.length}\n`);

missing.forEach((c) => {
  console.log(`${APPLY ? "SEED" : "WOULD SEED"}  ${c.clientName} -- accountHead "${c.accountHead}"`);
});

if (APPLY && missing.length) {
  await ClientAccountHeadLog.insertMany(
    missing.map((c) => ({
      clientId: c._id,
      action: "SET",
      accountHead: c.accountHead,
      performedBy: "SYSTEM",
    })),
  );
  console.log(`\nSeeded ${missing.length} client(s).`);
} else if (!APPLY && missing.length) {
  console.log("\nDry-run only. Re-run with --apply to commit.");
}

await mongoose.disconnect();
process.exit(0);
