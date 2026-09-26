import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import PosRoll from "../models/inventory/posRoll.js";
import PosRollStock from "../models/inventory/PosRollStock.js";
import PosRollStockLog from "../models/inventory/PosRollStockLog.js";
import TapeSalesOrder from "../models/inventory/TapeSalesOrder.js";

dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });

// Existing imports created before the POS Roll reference was normalized can
// contain a string ObjectId (or the human POS product id). This migration
// converts only resolvable POS Roll references to BSON ObjectIds.
const APPLY = process.argv.includes("--apply");

await connectDB();
console.log(`Mode: ${APPLY ? "APPLY (writing changes)" : "DRY-RUN (no changes)"}`);

const products = await PosRoll.find({}).select("_id posProductId").lean();
const byId = new Map(products.map((p) => [String(p._id), p._id]));
const byProductId = new Map(products.filter((p) => p.posProductId).map((p) => [String(p.posProductId), p._id]));

const formatProductId = (n) => `FS | POS Roll | ${String(n).padStart(6, "0")}`;
const sequenceOf = (value) => {
  const match = String(value || "").match(/(\d{6})$/);
  return match ? Number(match[1]) : 0;
};

const missingSerials = await PosRoll.collection
  .find({ $or: [{ posProductId: { $exists: false } }, { posProductId: null }, { posProductId: "" }] })
  .sort({ createdAt: 1, _id: 1 })
  .toArray();
let nextSequence = Math.max(0, ...products.map((p) => sequenceOf(p.posProductId))) + 1;
let serialsFixed = 0;
for (const doc of missingSerials) {
  while (byProductId.has(formatProductId(nextSequence))) nextSequence++;
  const productId = formatProductId(nextSequence++);
  serialsFixed++;
  console.log(`${APPLY ? "FIX" : "WOULD FIX"} PosRoll ${doc._id}: posProductId -> ${productId}`);
  if (APPLY) await PosRoll.collection.updateOne({ _id: doc._id }, { $set: { posProductId: productId } });
  byProductId.set(productId, doc._id);
}

const resolve = (value) => {
  if (value == null) return null;
  const text = String(value);
  if (byId.has(text)) return byId.get(text);
  return byProductId.get(text) || null;
};

async function migrate(model, field, filter = { [field]: { $type: "string" } }) {
  const docs = await model.find(filter).select(`_id ${field}`).lean();
  let updated = 0;
  let unresolved = 0;
  for (const doc of docs) {
    const resolved = resolve(doc[field]);
    if (!resolved) {
      unresolved++;
      console.log(`UNRESOLVED ${model.modelName} ${doc._id}: ${field}=${doc[field]}`);
      continue;
    }
    updated++;
    console.log(`${APPLY ? "FIX" : "WOULD FIX"} ${model.modelName} ${doc._id}: ${doc[field]} -> ${resolved}`);
    if (APPLY) await model.collection.updateOne({ _id: doc._id }, { $set: { [field]: resolved } });
  }
  return { updated, unresolved };
}

const stock = await migrate(PosRollStock, "posRoll");
const logs = await migrate(PosRollStockLog, "posRoll");
const orders = await migrate(TapeSalesOrder, "tapeId", { onModel: "PosRoll", tapeId: { $type: "string" } });

const total = serialsFixed + stock.updated + logs.updated + orders.updated;
console.log(`\n${APPLY ? "Updated" : "Would update"} ${total} reference(s).`);
console.log(`Unresolved references left untouched: ${stock.unresolved + logs.unresolved + orders.unresolved}.`);
if (!APPLY) console.log("Run with --apply to commit the migration.");

await mongoose.disconnect();
