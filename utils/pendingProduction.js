import PendingProduction from "../models/inventory/PendingProduction.js";

/*
 * Keeps the PendingProduction collection in sync with label/color-label sales
 * orders. Call upsertPendingProduction whenever an order becomes/stays
 * PENDING (create, edit, or a partial dispatch that leaves quantity
 * remaining); call removePendingProduction the moment it stops being PENDING
 * (confirmed, cancelled, or fully dispatched).
 *
 * `order` must have: _id, onModel ("Label" | "ColorLabel"), labelId or
 * colorLabelId, userId, quantity, dispatchedQuantity, poNumber, orderRate,
 * estimatedDate, remarks — i.e. a LabelSalesOrder/ColorLabelSalesOrder
 * document (lean or full).
 */
export async function upsertPendingProduction(order) {
  if (!order || (order.onModel !== "Label" && order.onModel !== "ColorLabel")) return;

  const itemId = order.onModel === "ColorLabel" ? order.colorLabelId : order.labelId;
  if (!itemId || !order.userId) return;

  await PendingProduction.findOneAndUpdate(
    { _id: order._id },
    {
      _id: order._id,
      onModel: order.onModel,
      itemId,
      userId: order.userId,
      quantity: order.quantity,
      dispatchedQuantity: order.dispatchedQuantity || 0,
      poNumber: order.poNumber,
      orderRate: order.orderRate,
      estimatedDate: order.estimatedDate,
      remarks: order.remarks,
    },
    { upsert: true, setDefaultsOnInsert: true },
  );
}

export async function removePendingProduction(orderId) {
  if (!orderId) return;
  await PendingProduction.deleteOne({ _id: orderId });
}
