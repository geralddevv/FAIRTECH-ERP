import mongoose from "mongoose";

/*
 * One document per label/color-label sales order currently sitting in the
 * production queue (status PENDING). Kept live-synced by
 * utils/pendingProduction.js from routes/fairdesk_route.js's
 * POST /sales/order and POST /sales/order/status handlers — a document is
 * upserted whenever an order becomes/stays PENDING, and removed the moment
 * it's confirmed, cancelled, or fully dispatched.
 *
 * _id is deliberately set to match the source LabelSalesOrder/ColorLabelSalesOrder
 * _id, NOT auto-generated — the pendingProduction.ejs view's action buttons
 * (view/mark-done/cancel) pass this id straight through to
 * /fairtech/sales/order/status and /fairtech/sales/order/confirm, which look
 * up the order by that same _id.
 *
 * Only itemId/userId are stored as references (populated live when the page
 * renders) — no denormalized client/user name snapshot, to avoid the same
 * staleness problem Label/ColorLabel bindings had.
 */
const pendingProductionSchema = new mongoose.Schema(
  {
    // No explicit _id field — Mongoose's default ObjectId _id path is used as-is,
    // callers just pass their own _id (the source order's _id) instead of
    // letting one be auto-generated.
    onModel: { type: String, enum: ["Label", "ColorLabel"], required: true },
    itemId: { type: mongoose.Schema.Types.ObjectId, required: true, refPath: "onModel", index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "Username", required: true, index: true },
    quantity: { type: Number, required: true },
    dispatchedQuantity: { type: Number, default: 0 },
    poNumber: { type: String },
    orderRate: { type: Number },
    estimatedDate: { type: Date },
    remarks: { type: String },
  },
  { timestamps: true },
);

export default mongoose.models.PendingProduction ||
  mongoose.model("PendingProduction", pendingProductionSchema, "pendingproductions");
