import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import { getTasksConnection } from "../config/tasksDb.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * One-time move: the "tasks" collection used to live in the main app
 * database; it now lives in an isolated database (config/tasksDb.js) for
 * privacy. This copies every existing document across, then (with --apply)
 * drops the old collection from the main database so it's not left behind
 * as a stale duplicate.
 *
 * Idempotent: re-running skips documents whose _id already exists in the
 * destination. Pass --apply to write; defaults to a dry run.
 */

const APPLY = process.argv.includes("--apply");

function withAuth(uri) {
  const user = process.env.MONGO_USER;
  const pass = process.env.MONGO_PASS;
  if (user && pass && uri.startsWith("mongodb://") && !uri.includes("@")) {
    uri = uri.replace("mongodb://", `mongodb://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@`);
    if (!uri.includes("authSource")) uri += (uri.includes("?") ? "&" : "?") + "authSource=admin";
  }
  return uri;
}

async function run() {
  const mainUri = withAuth(process.env.MONGO_URI || "mongodb://localhost:27017/fairdesk");
  const mainConn = await mongoose.createConnection(mainUri).asPromise();
  const tasksConn = await getTasksConnection().asPromise();
  console.log(`Connected to both databases.${APPLY ? "" : "  (DRY RUN — pass --apply to write changes)"}\n`);

  const sourceCollection = mainConn.collection("tasks");
  const destCollection = tasksConn.collection("tasks");

  const sourceDocs = await sourceCollection.find({}).toArray();
  const destIds = new Set((await destCollection.find({}, { projection: { _id: 1 } }).toArray()).map((d) => String(d._id)));

  const toInsert = sourceDocs.filter((d) => !destIds.has(String(d._id)));

  console.log(`Source (main db) tasks: ${sourceDocs.length}`);
  console.log(`Already present in destination: ${sourceDocs.length - toInsert.length}`);
  console.log(`${APPLY ? "Copying" : "Would copy"}: ${toInsert.length}`);
  toInsert.forEach((d) => console.log(`  + ${d._id} "${d.title}"`));

  if (APPLY && toInsert.length) {
    await destCollection.insertMany(toInsert);
  }

  if (APPLY && sourceDocs.length) {
    await sourceCollection.drop();
    console.log("\nDropped the old \"tasks\" collection from the main database.");
  }

  console.log("\n==========================================");
  console.log(APPLY ? "Done — changes written." : "Dry run complete — re-run with --apply to write these changes.");

  await mainConn.close();
  await tasksConn.close();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
