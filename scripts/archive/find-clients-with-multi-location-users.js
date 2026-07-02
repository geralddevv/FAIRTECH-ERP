import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Username from "../../models/users/username.js";
import dotenv from "dotenv";

// Load .env from the FAIRTECH root regardless of the current working directory
// (the script may be run from scripts/ or from the project root).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

// Report clients that have one or more users carrying more than one location
// (i.e. the user's `locationDetails` array holds 2+ entries).
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
    console.log("Database connected.\n");

    // Users whose locationDetails array holds more than one location.
    const users = await Username.find({
      $expr: { $gt: [{ $size: { $ifNull: ["$locationDetails", []] } }, 1] },
    })
      .select("clientId clientName userName locationsCount locationDetails")
      .sort({ clientName: 1, userName: 1 })
      .lean();

    if (!users.length) {
      console.log("No users with multiple locations found.");
      return process.exit(0);
    }

    // Group the matching users under their client.
    const byClient = new Map();
    for (const u of users) {
      const key = u.clientName || u.clientId || "(unknown client)";
      if (!byClient.has(key)) byClient.set(key, []);
      byClient.get(key).push(u);
    }

    console.log(`Clients with multi-location users: ${byClient.size}`);
    console.log(`Users with multiple locations:    ${users.length}`);
    console.log("=".repeat(64));

    for (const [clientName, clientUsers] of byClient) {
      console.log(`\nCLIENT: ${clientName}  (${clientUsers.length} user${clientUsers.length > 1 ? "s" : ""})`);
      for (const u of clientUsers) {
        const locs = (u.locationDetails || []).map((l) => l.userLocation).filter(Boolean);
        console.log(`  • ${u.userName} — ${locs.length} locations: ${locs.join(", ")}`);
      }
    }
    console.log("\n" + "=".repeat(64));

    process.exit(0);
  } catch (err) {
    console.error("Query failed:", err);
    process.exit(1);
  }
}

run();
