import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import Location from "../models/system/location.js";
import TapeSalesOrder from "../models/inventory/TapeSalesOrder.js";
import TapeStock from "../models/inventory/TapeStock.js";
import PosRollStock from "../models/inventory/PosRollStock.js";
import TafetaStock from "../models/inventory/TafetaStock.js";
import TtrStock from "../models/inventory/TtrStock.js";

// ---------------------------------------------------------------------------
// Repair stock-tracked sales orders (Tape / POS Roll / Tafeta / TTR) whose
// sourceLocation is not a warehouse from Location Master.
//
// Those orders carry the *client's delivery location* instead -- a town or area
// such as WALUJ or BHIWANDI, which came from the order form's Location dropdown
// (Username.userLocation / <item>Binding.location). Stock is never held there,
// so the order is stuck:
//
//   * the confirm page locks dispatch to that location, finds no matching
//     stock-bar radio, and so disables every location -- nothing selectable;
//   * POST /sales/order/status then reports "cannot dispatch, not enough
//     stocks", because it looks for <Item>Stock at that exact string.
//
// Label / Color Label orders are left alone: they aren't stock-tracked, and for
// them sourceLocation legitimately records the delivery location.
//
// Dry-run by default; pass --apply to write.
//
//   node scripts/fix-order-source-location.js                        # report
//   node scripts/fix-order-source-location.js --apply                # fix the unambiguous ones
//   node scripts/fix-order-source-location.js --order=<id> --location="UNIT 2" --apply
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const orderArg = args.find((a) => a.startsWith("--order="));
const locationArg = args.find((a) => a.startsWith("--location="));
const ONLY_ORDER = orderArg ? orderArg.slice("--order=".length).trim() : null;
const FORCE_LOCATION = locationArg ? locationArg.slice("--location=".length).trim() : null;

if (FORCE_LOCATION && !ONLY_ORDER) {
  console.error("--location= needs --order=<id>: it sets one order's location explicitly.");
  process.exit(1);
}

const canonical = (value) =>
  String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, " ")
    .replace(/^[.,]+|[.,]+$/g, "");

// onModel -> the stock collection and the field naming the item on it.
const STOCK_BY_MODEL = {
  Tape: { Model: TapeStock, field: "tape" },
  PosRoll: { Model: PosRollStock, field: "posRoll" },
  Tafeta: { Model: TafetaStock, field: "tafeta" },
  Ttr: { Model: TtrStock, field: "ttr" },
};

await connectDB();

const stockLocations = [
  ...new Set((await Location.distinct("locationName")).map(canonical).filter(Boolean)),
].sort();
console.log(`Stock locations in Location Master: ${stockLocations.join(", ")}\n`);

const query = { status: { $ne: "CANCELLED" } };
if (ONLY_ORDER) query._id = new mongoose.Types.ObjectId(ONLY_ORDER);

const orders = await TapeSalesOrder.find(query).lean();
const broken = orders.filter((o) => !stockLocations.includes(canonical(o.sourceLocation)));

if (broken.length === 0) {
  console.log(ONLY_ORDER ? "That order's source location is already a stock location." : "No orders to repair.");
  await mongoose.disconnect();
  process.exit(0);
}

let fixed = 0;
let ambiguous = 0;

for (const order of broken) {
  const stock = STOCK_BY_MODEL[order.onModel];
  const label = `${order._id}  ${String(order.onModel).padEnd(8)} ${String(order.status).padEnd(10)} PO ${order.poNumber || "-"}`;

  if (!stock) {
    console.log(`${label}\n  saved location : ${JSON.stringify(order.sourceLocation)}\n  SKIPPED: unknown onModel\n`);
    ambiguous++;
    continue;
  }

  // Where this item's stock actually sits, master locations only.
  const byLocation = (
    await stock.Model.aggregate([
      { $match: { [stock.field]: new mongoose.Types.ObjectId(order.tapeId) } },
      { $group: { _id: "$location", qty: { $sum: "$quantity" } } },
    ])
  )
    .map((row) => ({ location: canonical(row._id), qty: Number(row.qty) || 0 }))
    .filter((row) => stockLocations.includes(row.location));

  const withStock = byLocation.filter((row) => row.qty > 0);
  const stockText = byLocation.length
    ? byLocation.map((row) => `${row.location}=${row.qty}`).join(", ")
    : "(none anywhere)";

  console.log(label);
  console.log(`  saved location : ${JSON.stringify(order.sourceLocation)}  (not a stock location)`);
  console.log(`  qty            : ${order.quantity} ordered, ${order.dispatchedQuantity || 0} dispatched`);
  console.log(`  item stock     : ${stockText}`);

  // An explicit --location wins; otherwise only an unambiguous single location
  // holding stock is safe to pick without a human deciding.
  let target = null;
  if (FORCE_LOCATION) {
    target = canonical(FORCE_LOCATION);
    if (!stockLocations.includes(target)) {
      console.log(`  --> REFUSED: "${target}" is not in Location Master\n`);
      ambiguous++;
      continue;
    }
  } else if (withStock.length === 1) {
    target = withStock[0].location;
  } else {
    console.log(
      `  --> NEEDS A DECISION: ${withStock.length === 0 ? "this item has no stock at any location" : "stock sits at several locations"}.`,
    );
    console.log(`      Re-run with --order=${order._id} --location="<LOCATION>" --apply\n`);
    ambiguous++;
    continue;
  }

  console.log(`  --> ${APPLY ? "set" : "would set"} sourceLocation = ${target}`);
  if (APPLY) {
    await TapeSalesOrder.updateOne({ _id: order._id }, { $set: { sourceLocation: target } });
  }
  fixed++;
  console.log("");
}

console.log(
  `${broken.length} order(s) with a non-stock source location: ${fixed} ${APPLY ? "repaired" : "repairable"}, ${ambiguous} need a decision.`,
);
if (!APPLY && fixed > 0) console.log("Dry run -- re-run with --apply to write.");

await mongoose.disconnect();
