import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
// Load .env from the project root regardless of the current working directory.
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import Client from "../models/users/client.js";
import Username from "../models/users/username.js";

const APPLY = process.argv.includes("--apply");

await connectDB();

// Find every client OR username whose name has a leading/trailing space or an
// internal run of 2+ whitespace chars, and normalize it.
const collapse = (s) => String(s).trim().replace(/\s+/g, " ");

let clientFixes = 0;
const clients = await Client.find({ clientName: /\s\s|^\s|\s$/ }).lean();
for (const c of clients) {
  const clean = collapse(c.clientName);
  if (clean !== c.clientName) {
    console.log(`CLIENT  ${JSON.stringify(c.clientName)}  ->  ${JSON.stringify(clean)}  (_id ${c._id})`);
    if (APPLY) await Client.updateOne({ _id: c._id }, { $set: { clientName: clean } });
    clientFixes++;
  }
}

let userFixes = 0;
const users = await Username.find({ clientName: /\s\s|^\s|\s$/ }).lean();
for (const u of users) {
  const clean = collapse(u.clientName);
  if (clean !== u.clientName) {
    console.log(`USER    ${JSON.stringify(u.userName)}  clientName ${JSON.stringify(u.clientName)}  ->  ${JSON.stringify(clean)}  (_id ${u._id})`);
    if (APPLY) await Username.updateOne({ _id: u._id }, { $set: { clientName: clean } });
    userFixes++;
  }
}

console.log(`\n${APPLY ? "APPLIED" : "DRY RUN"} — clients to fix: ${clientFixes}, usernames to fix: ${userFixes}`);
console.log(APPLY ? "Changes written." : "Re-run with --apply to write changes.");

await mongoose.disconnect();
process.exit(0);
