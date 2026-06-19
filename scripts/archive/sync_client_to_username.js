import mongoose from "mongoose";
import Client from "../../models/users/client.js";
import Username from "../../models/users/username.js";

const MONGO_URI = "mongodb://127.0.0.1:27017/fairdesk";
const SYNC_FIELDS = ["clientId", "clientName", "clientType", "clientStatus", "hoLocation", "accountHead"];

async function main() {
  const applyMode = process.argv.includes("--apply");

  console.log("\n  Starting sync...");
  console.log("  Mode: " + (applyMode ? "APPLY" : "DRY-RUN"));

  try {
    console.log("  Connecting to MongoDB...");
    await mongoose.connect(MONGO_URI);
    console.log("  Connected.\n");

    const clients = await Client.find({});
    console.log(`  Found ${clients.length} clients.`);

    let totalMismatches = 0;
    let totalUsersUpdated = 0;

    for (const client of clients) {
      const users = await Username.find({ clientId: client.clientId });
      if (users.length === 0) continue;

      for (const user of users) {
        const diffs = {};
        for (const field of SYNC_FIELDS) {
          const clientVal = String(client[field] || "").trim();
          const userVal = String(user[field] || "").trim();

          if (clientVal !== userVal) {
            diffs[field] = { from: userVal, to: clientVal };
          }
        }

        if (Object.keys(diffs).length > 0) {
          totalMismatches++;
          console.log(`  Mismatch found for user: ${user.userName} (Client CID: ${client.clientId})`);
          for (const [field, val] of Object.entries(diffs)) {
            console.log(`    ${field}: "${val.from}" -> "${val.to}"`);
          }

          if (applyMode) {
            const updateObj = {};
            for (const [field, val] of Object.entries(diffs)) {
              updateObj[field] = val.to;
            }
            await Username.findByIdAndUpdate(user._id, updateObj);
            console.log("    -> Updated successfully.");
            totalUsersUpdated++;
          }
          console.log("");
        }
      }
    }

    console.log("  ----------------------------------------");
    console.log(`  Total mismatches found: ${totalMismatches}`);
    if (applyMode) {
      console.log(`  Total users updated:    ${totalUsersUpdated}`);
    } else if (totalMismatches > 0) {
      console.log("\n  To apply these changes, run:");
      console.log("  node scripts/sync_client_to_username.js --apply");
    } else {
      console.log("  Everything is already in sync!");
    }
  } catch (error) {
    console.error("  Error during execution:", error);
  } finally {
    console.log("\n  Closing connection...");
    await mongoose.disconnect();
    console.log("  Done.\n");
    process.exit(0);
  }
}

main();
