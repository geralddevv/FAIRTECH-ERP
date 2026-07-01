import mongoose from "mongoose";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

import LabelSalesOrder from "../models/inventory/LabelSalesOrder.js";
import ColorLabelSalesOrder from "../models/inventory/ColorLabelSalesOrder.js";
import Label from "../models/inventory/labels.js";
import ColorLabel from "../models/inventory/colorLabel.js";

// Load .env from the FAIRTECH root regardless of the current working directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../.env") });

/*
 * Fix: label/color-label sales orders must carry an orderRate in the same
 * unit as their binding's moqUnit — per-roll (`perRoll`) when moqUnit is
 * "ROLLS", per-label (`ratePerLabel`) when it's "LABELS". GET /sales/items
 * used to always return ratePerLabel regardless of moqUnit, so ROLLS orders
 * ended up with a per-label rate saved against a rolls-based quantity (and,
 * in principle, the reverse mismatch could happen too if a rate were
 * entered against the wrong unit by hand).
 *
 * This script re-derives the correct rate for each order from its binding's
 * *current* moqUnit and corrects any order whose orderRate still matches
 * the OTHER unit's rate (i.e. the swapped value) — covering both
 * LABELS-binding and ROLLS-binding orders. Orders whose orderRate matches
 * neither the correct nor the swapped value are left untouched and reported
 * separately — those were likely hand-edited via "Curr Rate" and shouldn't
 * be overwritten blindly.
 *
 * Defaults to a dry run (report only). Pass --apply to write the fix.
 */

const APPLY = process.argv.includes("--apply");
const EPSILON = 0.01;

const closeEnough = (a, b) => Math.abs(a - b) < EPSILON;

async function fixOrders(OrderModel, BindingModel, idField, label) {
  const orders = await OrderModel.find({})
    .select(`_id ${idField} orderRate quantity status createdAt`)
    .lean();

  if (!orders.length) {
    console.log(`  ${label}: no orders found.`);
    return { fixed: 0, alreadyCorrect: 0, ambiguous: 0, missingBinding: 0 };
  }

  const bindingIds = [...new Set(orders.map((o) => String(o[idField])).filter(Boolean))];
  const bindings = await BindingModel.find({ _id: { $in: bindingIds } })
    .select("moqUnit perRollQty ratePerLabel perRoll")
    .lean();
  const bindingById = new Map(bindings.map((b) => [String(b._id), b]));

  let fixed = 0;
  let alreadyCorrect = 0;
  let ambiguous = 0;
  let missingBinding = 0;
  const ops = [];

  for (const order of orders) {
    const binding = bindingById.get(String(order[idField]));
    if (!binding) {
      missingBinding += 1;
      continue;
    }

    const moqUnit = binding.moqUnit || "LABELS";
    const ratePerLabel = parseFloat(binding.ratePerLabel) || 0;
    const perRollQty = Number(binding.perRollQty) || 0;
    const perRollRate = parseFloat(binding.perRoll) || (perRollQty ? ratePerLabel * perRollQty : 0);

    // The rate matching this order's *current* quantity unit, and the rate
    // for the OTHER unit (the swapped value we correct away from).
    const correctRate = moqUnit === "ROLLS" ? perRollRate : ratePerLabel;
    const swappedRate = moqUnit === "ROLLS" ? ratePerLabel : perRollRate;
    const correctLabel = moqUnit === "ROLLS" ? "per-roll" : "per-label";
    const swappedLabel = moqUnit === "ROLLS" ? "per-label" : "per-roll";

    const currentRate = Number(order.orderRate) || 0;

    if (!correctRate) {
      ambiguous += 1;
      console.warn(`  ! ${label} order ${order._id}: cannot determine a correct rate (binding ${order[idField]} missing rate/perRollQty data).`);
      continue;
    }

    if (closeEnough(currentRate, correctRate)) {
      alreadyCorrect += 1;
      continue;
    }

    if (!swappedRate || !closeEnough(currentRate, swappedRate)) {
      // orderRate matches neither the correct value nor the swapped-unit value —
      // likely a manually entered "Curr Rate". Leave it alone.
      ambiguous += 1;
      console.warn(
        `  ? ${label} order ${order._id} [${order.status}]: orderRate ${currentRate} (moqUnit ${moqUnit}) matches neither ` +
        `${correctLabel} (${correctRate}) nor ${swappedLabel} (${swappedRate}) — skipped, review manually.`,
      );
      continue;
    }

    fixed += 1;
    console.log(`  ${label} order ${order._id} [${order.status}] (moqUnit ${moqUnit}): ${currentRate} -> ${correctRate}`);
    if (APPLY) {
      ops.push({ updateOne: { filter: { _id: order._id }, update: { $set: { orderRate: correctRate } } } });
    }
  }

  if (APPLY && ops.length) {
    await OrderModel.collection.bulkWrite(ops, { ordered: false });
  }

  return { fixed, alreadyCorrect, ambiguous, missingBinding };
}

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
    console.log(`Database connected.${APPLY ? "" : "  (DRY RUN — pass --apply to write changes)"}\n`);

    console.log("Label sales orders:");
    const labelResult = await fixOrders(LabelSalesOrder, Label, "labelId", "Label");

    console.log("\nColor label sales orders:");
    const colorResult = await fixOrders(ColorLabelSalesOrder, ColorLabel, "colorLabelId", "ColorLabel");

    console.log("\n================ Summary ================");
    for (const [name, r] of [["Label", labelResult], ["ColorLabel", colorResult]]) {
      console.log(
        `${name}: ${APPLY ? "fixed" : "would fix"} ${r.fixed}, already correct ${r.alreadyCorrect}, ` +
        `ambiguous/skipped ${r.ambiguous}, missing binding ${r.missingBinding}`,
      );
    }
    console.log("==========================================");
    console.log(APPLY ? "Done — changes written." : "Dry run complete — re-run with --apply to write these changes.");

    process.exit(0);
  } catch (err) {
    console.error("Fix script failed:", err);
    process.exit(1);
  }
}

run();
