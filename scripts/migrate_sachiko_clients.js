/**
 * Migrate dealer clients (and their users) from the fairdesk DB into the
 * separate `sachiko` database, writing to the STANDARD collections.
 *
 * - Reads `clients` (clientType = "DEALER") from the source (fairdesk) DB and
 *   writes them into `clients` in the target (sachiko) DB with
 *   SP | CLIENT | 001 style IDs.
 * - Reads the associated `usernames` from the source DB and writes them into
 *   `usernames` in the target DB, updating clientId to the new SP ID.
 *
 * Source DB : process.env.MONGO_URI            (defaults to .../fairdesk)
 * Target DB : process.env.SACHIKO_MONGO_URI    (defaults to source URI with
 *             the database name swapped to "sachiko")
 *
 * Usage:
 *   node scripts/migrate_sachiko_clients.js           -- dry run (no writes)
 *   node scripts/migrate_sachiko_clients.js --apply   -- write to DB
 */

import mongoose from "mongoose";
import { configDotenv } from "dotenv";

configDotenv({ quiet: true });

/** Swap the database name in a mongodb connection string. */
function withDbName(uri, dbName) {
  return uri.replace(
    /(\/\/[^/]+\/)([^?]*)(\?.*)?$/,
    (_m, pre, _db, query = "") => `${pre}${dbName}${query || ""}`,
  );
}

const SOURCE_URI =
  process.env.MONGO_URI || "mongodb://admin:YourStrongPassword@127.0.0.1:27017/fairdesk?authSource=admin";
const TARGET_URI = process.env.SACHIKO_MONGO_URI || withDbName(SOURCE_URI, "sachiko");

/* ── inline schema definitions ── */

const counterSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true },
  seq: { type: Number, required: true, default: 0 },
});

const clientSchema = new mongoose.Schema({
  clientId: String,
  clientName: String,
  clientType: String,
  clientStatus: String,
  hoLocation: String,
  accountHead: String,
  clientGst: String,
  clientMsme: String,
  clientGumasta: String,
  clientPan: String,
  clientSignature: String,
  // binding to the client's users (what the app populates)
  users: [{ type: mongoose.Schema.Types.ObjectId, ref: "Username" }],
  // tracking field for idempotency (only set on migrated docs)
  sourceClientId: String,
});

const usernameSchema = new mongoose.Schema({
  clientId: String,
  clientName: String,
  clientType: String,
  hoLocation: String,
  accountHead: String,
  userName: String,
  userLocation: String,
  userDepartment: String,
  userContact: String,
  userEmail: String,
  dispatchAddress: String,
  locationsCount: Number,
  locationDetails: [{ userLocation: String, dispatchAddress: String }],
  transportName: String,
  transportContact: String,
  dropLocation: String,
  deliveryMode: String,
  deliveryLocation: String,
  clientPayment: String,
  SelfDispatch: String,
  clientStatus: String,
  ownerName: String,
  ownerMobNo: String,
  ownerEmail: String,
  clientGst: String,
  clientMsme: String,
  clientGumasta: String,
  clientPan: String,
  userSignature: String,
  // tracking fields for idempotency (only set on migrated docs)
  sourceUserId: String,
  sourceClientId: String,
});

/* ── helpers ── */

function padSeq(n) {
  return String(n).padStart(3, "0");
}

/* ── main ── */

async function main() {
  const applyMode = process.argv.includes("--apply");

  console.log("\n  Sachiko Client Migration");
  console.log("  Mode:", applyMode ? "APPLY" : "DRY-RUN (pass --apply to write)");
  console.log("  Source (read) :", SOURCE_URI);
  console.log("  Target (write):", TARGET_URI, "\n");

  const sourceConn = await mongoose.createConnection(SOURCE_URI).asPromise();
  const targetConn = await mongoose.createConnection(TARGET_URI).asPromise();
  console.log("  Connected.\n");

  // Source models (fairdesk DB)
  const Client = sourceConn.model("Client", clientSchema, "clients");
  const Username = sourceConn.model("Username", usernameSchema, "usernames");

  // Target models (sachiko DB) — standard collection names
  const TargetClient = targetConn.model("Client", clientSchema, "clients");
  const TargetUsername = targetConn.model("Username", usernameSchema, "usernames");
  const Counter = targetConn.model("Counter", counterSchema);

  async function nextClientId() {
    const counter = await Counter.findOneAndUpdate(
      { key: "sachiko_clientId" },
      { $inc: { seq: 1 } },
      { upsert: true, new: true },
    );
    let seq = counter.seq;
    while (await TargetClient.exists({ clientId: `SP | CLIENT | ${padSeq(seq)}` })) {
      seq += 1;
    }
    return `SP | CLIENT | ${padSeq(seq)}`;
  }

  const dealers = await Client.find({ clientType: "DEALER" }).lean();
  console.log(`  Found ${dealers.length} DEALER client(s) in the source clients collection.\n`);

  if (dealers.length === 0) {
    console.log("  Nothing to migrate.");
    await sourceConn.close();
    await targetConn.close();
    process.exit(0);
  }

  let clientsCreated = 0;
  let clientsSkipped = 0;
  let usersCreated = 0;
  let usersSkipped = 0;

  for (const dealer of dealers) {
    const existing = await TargetClient.findOne({ sourceClientId: dealer.clientId }).lean();

    if (existing) {
      console.log(`  SKIP  "${dealer.clientName}" — already in target clients as ${existing.clientId}`);
      clientsSkipped++;

      const clientUsers = await Username.find({ clientId: dealer.clientId }).lean();
      for (const u of clientUsers) {
        const userExisting = await TargetUsername.findOne({ sourceUserId: String(u._id) }).lean();
        if (userExisting) {
          usersSkipped++;
        } else {
          console.log(`    USER NOT YET MIGRATED  "${u.userName}" — source client already migrated`);
          usersSkipped++;
        }
      }
      continue;
    }

    const newId = applyMode
      ? await nextClientId()
      : `SP | CLIENT | ${padSeq(clientsCreated + 1)}`;

    const clientUsers = await Username.find({ clientId: dealer.clientId }).lean();

    console.log(`  ${applyMode ? "CREATE" : "WOULD CREATE"}  "${dealer.clientName}"`);
    console.log(`    Source ID : ${dealer.clientId}`);
    console.log(`    New ID    : ${newId}`);
    console.log(`    Type      : ${dealer.clientType}`);
    console.log(`    Status    : ${dealer.clientStatus}`);
    console.log(`    Location  : ${dealer.hoLocation}`);
    console.log(`    Users     : ${clientUsers.length}`);

    // Create the users first so we can collect their _ids and bind them to the
    // client via the `users` array (which is what the app populates).
    const createdUserIds = [];
    for (const u of clientUsers) {
      const userExisting = await TargetUsername.findOne({ sourceUserId: String(u._id) }).lean();
      if (userExisting) {
        console.log(`      SKIP user "${u.userName}" — already migrated`);
        createdUserIds.push(userExisting._id);
        usersSkipped++;
        continue;
      }

      console.log(`      ${applyMode ? "CREATE" : "WOULD CREATE"} user  "${u.userName}"  (${u.userLocation})`);

      if (applyMode) {
        const createdUser = await TargetUsername.create({
          clientId: newId,
          clientName: dealer.clientName,
          clientType: dealer.clientType,
          hoLocation: dealer.hoLocation,
          accountHead: dealer.accountHead,
          userName: u.userName,
          userLocation: u.userLocation,
          userDepartment: u.userDepartment,
          userContact: u.userContact,
          userEmail: u.userEmail,
          dispatchAddress: u.dispatchAddress,
          locationsCount: u.locationsCount,
          locationDetails: u.locationDetails || [],
          transportName: u.transportName,
          transportContact: u.transportContact,
          dropLocation: u.dropLocation,
          deliveryMode: u.deliveryMode,
          deliveryLocation: u.deliveryLocation,
          clientPayment: u.clientPayment,
          SelfDispatch: u.SelfDispatch,
          clientStatus: u.clientStatus,
          ownerName: u.ownerName,
          ownerMobNo: u.ownerMobNo,
          ownerEmail: u.ownerEmail,
          clientGst: u.clientGst,
          clientMsme: u.clientMsme,
          clientGumasta: u.clientGumasta,
          clientPan: u.clientPan,
          userSignature: u.userSignature || undefined,
          sourceUserId: String(u._id),
          sourceClientId: dealer.clientId,
        });
        createdUserIds.push(createdUser._id);
      }
      usersCreated++;
    }

    if (applyMode) {
      await TargetClient.create({
        clientId: newId,
        clientName: dealer.clientName,
        clientType: dealer.clientType,
        clientStatus: dealer.clientStatus,
        hoLocation: dealer.hoLocation,
        accountHead: dealer.accountHead,
        clientGst: dealer.clientGst,
        clientMsme: dealer.clientMsme,
        clientGumasta: dealer.clientGumasta,
        clientPan: dealer.clientPan,
        clientSignature: dealer.clientSignature || undefined,
        users: createdUserIds,
        sourceClientId: dealer.clientId,
      });
    }
    clientsCreated++;
    console.log("");
  }

  console.log("  ─────────────────────────────────────");
  console.log(`  Clients found   : ${dealers.length}`);
  console.log(`  Clients skipped : ${clientsSkipped} (already migrated)`);
  console.log(`  Clients ${applyMode ? "created " : "to create"}: ${clientsCreated}`);
  console.log(`  Users skipped   : ${usersSkipped} (already migrated)`);
  console.log(`  Users ${applyMode ? "created  " : "to create"} : ${usersCreated}`);

  if (!applyMode && (clientsCreated + usersCreated) > 0) {
    console.log("\n  Run with --apply to write these records to the database.");
  }

  await sourceConn.close();
  await targetConn.close();
  console.log("\n  Done.\n");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});