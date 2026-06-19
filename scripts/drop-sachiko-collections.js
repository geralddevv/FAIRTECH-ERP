import mongoose from "mongoose";
import { configDotenv } from "dotenv";
import { fileURLToPath } from "url";
import path from "path";
import connectDB from "../config/db.js";

// Load .env from the project root regardless of the current working directory,
// so the script works whether run from the project root or from scripts/.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
configDotenv({ path: path.resolve(__dirname, "../.env") });

// Drops every collection in the connected database whose name starts with
// "sachiko" (case-insensitive). Run with --dry-run to preview without deleting.
//
//   node scripts/drop-sachiko-collections.js            # actually drops
//   node scripts/drop-sachiko-collections.js --dry-run  # preview only

const PREFIX = "sachiko";
const dryRun = process.argv.includes("--dry-run");

async function dropSachikoCollections() {
  try {
    await connectDB();

    const db = mongoose.connection.db;
    const dbName = mongoose.connection.name;

    const collections = await db.listCollections().toArray();
    const targets = collections
      .map((c) => c.name)
      .filter((name) => name.toLowerCase().startsWith(PREFIX));

    if (targets.length === 0) {
      console.log(`No collections starting with "${PREFIX}" found in "${dbName}".`);
      return;
    }

    console.log(
      `Found ${targets.length} collection(s) starting with "${PREFIX}" in "${dbName}":`
    );
    targets.forEach((name) => console.log(`  - ${name}`));

    if (dryRun) {
      console.log("\nDry run — nothing was dropped.");
      return;
    }

    for (const name of targets) {
      await db.dropCollection(name);
      console.log(`✓ Dropped ${name}`);
    }

    console.log(`\nDone. Dropped ${targets.length} collection(s).`);
  } catch (error) {
    console.error("Failed to drop sachiko collections:", error);
    process.exitCode = 1;
  } finally {
    await mongoose.connection.close();
    console.log("✓ Database connection closed");
  }
}

dropSachikoCollections();
