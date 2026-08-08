import mongoose from "mongoose";
import PendingProduction from "../models/inventory/PendingProduction.js";
import ProductionBinding from "../models/utilities/productionBinding.js";
import LabelSalesOrder from "../models/inventory/LabelSalesOrder.js";

/*
 * Keeps the PendingProduction collection in sync with label/color-label sales
 * orders. Call upsertPendingProduction whenever an order becomes/stays
 * PENDING (create, edit, or a partial dispatch that leaves quantity
 * remaining); call removePendingProduction the moment it stops being PENDING
 * (confirmed, cancelled, or fully dispatched).
 */

/*
 * Whether a Label binding is produced by an outsourcing vendor rather than
 * in-house. The flag lives on the Production Binding — set by the Out Source
 * checkbox beside Vendor Name on /fairtech/form/prodcalc — because it's a
 * decision about how the job is *made*, not about the client's side of the
 * binding.
 *
 * Keyed on labelProductId alone: a Label binding is already specific to one
 * client + user + location, so the label identifies the whole context. Any
 * one of its production bindings being outsourced makes the label outsourced
 * (a label can have several, one per die/block). Compared as strings because
 * ProductionBinding is a strict:false schema and stores labelProductId as the
 * raw form value, not a cast ObjectId.
 */
export async function isOutsourcedLabel(labelId) {
  if (!labelId) return false;
  const binding = await ProductionBinding.findOne({
    isOutsource: true,
    labelProductId: String(labelId),
  })
    .select("_id")
    .lean();
  return !!binding;
}

/*
 * Every Label id that has at least one outsourced production binding, ready to
 * drop straight into a `labelId: { $in: ... }` query -- the set-wise form of
 * isOutsourcedLabel above, used by the Outsourced Orders page
 * (routes/inventory/reorder.js). Non-ObjectId values are dropped:
 * labelProductId is a free-text field on the strict:false ProductionBinding
 * schema, so a stray value would otherwise blow up the caller's cast.
 */
export async function outsourcedLabelIds() {
  const bindings = await ProductionBinding.find({ isOutsource: true }).select("labelProductId").lean();
  return [
    ...new Set(
      bindings
        .map((b) => b.labelProductId)
        .filter((id) => id && mongoose.isValidObjectId(String(id)))
        .map(String),
    ),
  ];
}

/*
 * `order` must have: _id, onModel ("Label" | "ColorLabel"), labelId or
 * colorLabelId, userId, quantity, dispatchedQuantity, poNumber, orderRate,
 * estimatedDate, remarks — i.e. a LabelSalesOrder/ColorLabelSalesOrder
 * document (lean or full).
 */
export async function upsertPendingProduction(order) {
  if (!order || (order.onModel !== "Label" && order.onModel !== "ColorLabel")) return;

  const itemId = order.onModel === "ColorLabel" ? order.colorLabelId : order.labelId;
  if (!itemId || !order.userId) return;

  // Outsourced labels aren't produced in-house -- they have no machine/operator
  // queue to join, so their orders route to the Outsourced Orders page
  // (routes/inventory/reorder.js) instead of Pending Production.
  if (order.onModel === "Label" && (await isOutsourcedLabel(itemId))) return;

  await PendingProduction.findOneAndUpdate(
    { _id: order._id },
    {
      $set: {
        onModel: order.onModel,
        itemId,
        userId: order.userId,
        quantity: order.quantity,
        dispatchedQuantity: order.dispatchedQuantity || 0,
        poNumber: order.poNumber,
        orderRate: order.orderRate,
        // Per label or per 1000 -- carried across so the rate can't be read on
        // the wrong scale here (models/inventory/LabelSalesOrder.js).
        orderRateUnit: order.orderRateUnit,
        estimatedDate: order.estimatedDate,
        remarks: order.remarks,
      },
    },
    { upsert: true, setDefaultsOnInsert: true },
  );
}

export async function removePendingProduction(orderId) {
  if (!orderId) return;
  await PendingProduction.deleteOne({ _id: orderId });
}

/*
 * Re-runs the outsourced/in-house decision for every PENDING order already
 * placed against a Label, and moves those orders to whichever queue the label
 * now belongs in. Called after a production binding is saved on
 * /fairtech/form/prodcalc, since orders placed *before* the Out Source
 * checkbox was ticked (or unticked) would otherwise sit in the wrong queue —
 * or, worse, show on both Pending Production and Outsourced Orders at once,
 * as Outsourced Orders reads the sales orders directly rather than
 * PendingProduction.
 *
 * Rows already sent through Assign Production (assignedMachineId set) are left
 * alone: that job is on a machine with a lot no. against it, and pulling it
 * out from under the shopfloor is not something a binding edit should do.
 */
export async function resyncPendingProductionForLabel(labelId) {
  // labelProductId is a free-text field on the strict:false ProductionBinding
  // schema, so a binding can carry something that isn't a label id at all --
  // bail rather than let Mongoose throw casting it.
  if (!labelId || !mongoose.isValidObjectId(String(labelId))) return;

  if (await isOutsourcedLabel(labelId)) {
    await PendingProduction.deleteMany({
      onModel: "Label",
      itemId: labelId,
      assignedMachineId: null,
    });
    return;
  }

  const orders = await LabelSalesOrder.find({ labelId, status: "PENDING" }).lean();
  for (const order of orders) {
    await upsertPendingProduction(order);
  }
}
