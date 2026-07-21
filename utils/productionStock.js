import mongoose from "mongoose";
import SemiFinishedStock from "../models/inventory/SemiFinishedStock.js";
import SemiFinishedStockLog from "../models/inventory/SemiFinishedStockLog.js";
import FinishedStock from "../models/inventory/FinishedStock.js";
import FinishedStockLog from "../models/inventory/FinishedStockLog.js";

/*
 * Stock movements across the two production stages.
 *
 *   printing  ──▶  SemiFinishedStock (rolls)
 *   slitting  ──▶  consumes rolls, produces FinishedStock (labels)
 *   dispatch  ──▶  consumes labels
 *
 * Both collections are append-only ledgers, exactly like TapeStock/PaperStock:
 * each row is a signed delta and the balance is their sum. Never update a row
 * in place — write another delta, so the log and the balance can't disagree.
 *
 * Mirrors applyStockDelta() in routes/stock/stockView.js; kept here rather than
 * imported from that route file so both the production routes and the stock
 * routes can use it without one depending on the other.
 */

const toNumber = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const toUpperLocation = (value) => String(value ?? "").trim().toUpperCase();

const STAGES = {
  semiFinished: { stockModel: SemiFinishedStock, logModel: SemiFinishedStockLog, unit: "rolls" },
  finished: { stockModel: FinishedStock, logModel: FinishedStockLog, unit: "labels" },
};

function resolveStage(stage) {
  const cfg = STAGES[stage];
  if (!cfg) throw new Error(`Unknown production stock stage: ${stage}`);
  return cfg;
}

/**
 * Current on-hand balance for one item at one location, in that stage's unit.
 */
export async function getProductionStockBalance({ stage, itemId, onModel, location }) {
  const { stockModel } = resolveStage(stage);
  const [row] = await stockModel.aggregate([
    {
      $match: {
        itemId: new mongoose.Types.ObjectId(String(itemId)),
        onModel,
        location: toUpperLocation(location),
      },
    },
    { $group: { _id: null, qty: { $sum: { $ifNull: ["$quantity", 0] } } } },
  ]);
  return toNumber(row?.qty);
}

/**
 * Append a signed delta to a stage's ledger plus its matching log entry.
 *
 * Pass allowNegative: false to refuse a movement that would take the balance
 * below zero — the caller gets { changed: false, insufficient: true } back so
 * it can surface its own message rather than have one thrown at it.
 */
export async function applyProductionStockDelta({
  stage,
  itemId,
  onModel,
  location,
  delta,
  remarks,
  createdBy,
  source = "SYSTEM",
  allowNegative = true,
}) {
  const { stockModel, logModel } = resolveStage(stage);
  const itemObjectId = new mongoose.Types.ObjectId(String(itemId));
  const normalizedLocation = toUpperLocation(location);

  const openingStock = await getProductionStockBalance({ stage, itemId, onModel, location });
  const closingStock = openingStock + delta;

  if (delta === 0) return { openingStock, closingStock, changed: false, insufficient: false };
  if (!allowNegative && closingStock < 0) {
    return { openingStock, closingStock, changed: false, insufficient: true };
  }

  await stockModel.create({
    onModel,
    itemId: itemObjectId,
    location: normalizedLocation,
    quantity: delta,
    remarks,
  });

  await logModel.create({
    onModel,
    itemId: itemObjectId,
    location: normalizedLocation,
    openingStock,
    quantity: Math.abs(delta),
    closingStock,
    type: delta > 0 ? "INWARD" : "OUTWARD",
    source,
    remarks,
    createdBy: createdBy || "SYSTEM",
  });

  return { openingStock, closingStock, changed: true, insufficient: false };
}

/**
 * Printing run finished — rolls come off the press into semi finished stock.
 */
export function addSemiFinished({ itemId, onModel, location, rolls, remarks, createdBy }) {
  return applyProductionStockDelta({
    stage: "semiFinished",
    itemId, onModel, location,
    delta: Math.abs(toNumber(rolls)),
    remarks, createdBy,
  });
}

/**
 * Slitting run — rolls are consumed and become labels. The two legs are written
 * separately because they are in different units; `rolls` is what leaves semi
 * finished and `labels` is what the slitter actually yielded, which is why the
 * caller supplies both rather than this deriving one from the other.
 */
export async function recordSlitting({ itemId, onModel, location, rolls, labels, remarks, createdBy }) {
  const consumed = await applyProductionStockDelta({
    stage: "semiFinished",
    itemId, onModel, location,
    delta: -Math.abs(toNumber(rolls)),
    remarks, createdBy,
    allowNegative: false,
  });
  if (consumed.insufficient) return { consumed, produced: null };

  const produced = await applyProductionStockDelta({
    stage: "finished",
    itemId, onModel, location,
    delta: Math.abs(toNumber(labels)),
    remarks, createdBy,
  });
  return { consumed, produced };
}

/**
 * Dispatch — labels leave finished stock.
 */
export function consumeFinished({ itemId, onModel, location, labels, remarks, createdBy, allowNegative = false }) {
  return applyProductionStockDelta({
    stage: "finished",
    itemId, onModel, location,
    delta: -Math.abs(toNumber(labels)),
    remarks, createdBy,
    allowNegative,
  });
}
