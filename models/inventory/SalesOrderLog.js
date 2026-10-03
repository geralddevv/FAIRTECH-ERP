import mongoose from "mongoose";

const salesOrderLogSchema = new mongoose.Schema(
  {
    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "TapeSalesOrder",
      required: true,
      index: true,
    },

    action: {
      type: String,
      enum: ["CREATED", "CONFIRMED", "CANCELLED", "DELIVERED", "PRECLOSE"],
      required: true,
    },

    invoiceNumber: {
      type: String,
      trim: true,
    },

    quantity: {
      type: Number,
    },

    // Only set when action is PRECLOSE — the qty entered in the Preclose Qty
    // field, kept separate from `quantity` (which stays the actual dispatched
    // amount used for stock deduction/reversal) so edit/delete log math keeps
    // working off the physical qty unaffected by this bookkeeping figure.
    precloseQty: {
      type: Number,
    },

    // Only set on a DELIVERED dispatch submitted with the confirm page's Extra
    // panel open and at least one of its fields filled in. Extra isn't its own
    // action: it's an ordinary invoiced dispatch carrying these extra details,
    // so the dispatched qty still lives in `quantity` and every query keyed on
    // action "DELIVERED" keeps counting it.
    isExtra: {
      type: Boolean,
    },

    // Extra panel's Roll Qty / Per Roll Qty, as entered. Bookkeeping only --
    // nothing here feeds stock deduction or dispatchedQuantity.
    rollQty: {
      type: Number,
    },

    perRollQty: {
      type: Number,
    },

    cancelReason: {
      type: String,
      trim: true,
    },

    // Only set when action is PRECLOSE — why the order is being closed out
    // short of its full quantity, entered in place of an Invoice Number
    // (preclosing an order doesn't dispatch against an invoice).
    precloseReason: {
      type: String,
      trim: true,
    },

    performedBy: {
      type: String,
      default: "SYSTEM",
    },

    performedAt: {
      type: Date,
      default: Date.now,
    },
  },
  {
    timestamps: true,
  },
);

// Fast retrieval for recent actions per order
salesOrderLogSchema.index({ orderId: 1, performedAt: -1 });
salesOrderLogSchema.index({ action: 1, performedAt: -1 });

export default mongoose.models.SalesOrderLog || mongoose.model("SalesOrderLog", salesOrderLogSchema);
