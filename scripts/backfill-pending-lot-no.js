/*
 * One-off backfill: give every already-assigned production order a lot no.
 *
 * Lot numbers started being claimed at assign time (POST
 * /fairtech/labels/production/assign/:id) — orders assigned before that have
 * none, so the machine queue and their job cards show "—". This walks the same
 * `lotNo` counter and skips any number already used by an order or a job card,
 * exactly as generateLotNo() in routes/fairdesk_route.js does.
 *
 * Safe to re-run: orders that already have a lot no are left alone.
 *
 *   node scripts/backfill-pending-lot-no.js
 */
import "dotenv/config";
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import PendingProduction from "../models/inventory/PendingProduction.js";
import JobCard from "../models/inventory/JobCard.js";
import Counter from "../models/system/counter.js";

const formatLotNo = (seq) => `FS | LOT | ${String(seq).padStart(4, "0")}`;

async function generateLotNo() {
  for (let i = 0; i < 10000; i++) {
    const counter = await Counter.findOneAndUpdate(
      { key: "lotNo" },
      { $inc: { seq: 1 } },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    ).lean();
    const candidate = formatLotNo(counter.seq);
    const [heldByOrder, onJobCard] = await Promise.all([
      PendingProduction.exists({ lotNo: candidate }),
      JobCard.exists({ lotNo: candidate }),
    ]);
    if (!heldByOrder && !onJobCard) return candidate;
  }
  throw new Error("Unable to generate a unique lot no");
}

await connectDB();

// Oldest assignment first, so lot numbers run in the order the work was queued.
const orders = await PendingProduction.find({
  assignedMachineId: { $ne: null },
  $or: [{ lotNo: { $exists: false } }, { lotNo: null }, { lotNo: "" }],
})
  .select("_id assignedAt")
  .sort({ assignedAt: 1 })
  .lean();

console.log(`Assigned orders without a lot no: ${orders.length}`);

for (const order of orders) {
  const lotNo = await generateLotNo();
  await PendingProduction.updateOne({ _id: order._id }, { $set: { lotNo } });
  console.log(`  ${order._id} -> ${lotNo}`);
}

console.log("Done.");
await mongoose.disconnect();
