import mongoose from "mongoose";

const labelSalesOrderSchema = new mongoose.Schema(
  {
    labelId: { type: mongoose.Schema.Types.ObjectId, ref: "Label", required: true, index: true },
    // tapeId mirrors labelId — kept so salesOrderForm.ejs and the confirm/status
    // routes that populate/read `order.tapeId.*` keep working without changes.
    tapeId: { type: mongoose.Schema.Types.ObjectId, ref: "Label", index: true },
    onModel: { type: String, default: "Label" },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "Username", required: true, index: true },
    quantity: { type: Number, required: true, min: 1 },
    dispatchedQuantity: { type: Number, default: 0 },
    // Where this order's stock is drawn from — same field, same normalisation
    // as TapeSalesOrder, so the shared dispatch path can read it uniformly.
    // Feeds the SemiFinishedStock/FinishedStock ledgers (utils/productionStock.js).
    sourceLocation: { type: String, trim: true, uppercase: true },
    poDate: { type: Date },
    poNumber: { type: String, trim: true },
    orderRate: { type: Number, default: 0 },
    // What one unit of orderRate buys. Label orders are quoted per 1000 labels
    // (the binding's gross "Rate Per 1000" / ratePerK), while quantity is in
    // labels -- so order value is quantity * orderRate / 1000. Orders placed
    // before that switch stored the net per-label rate instead and carry no
    // orderRateUnit at all; every value calc treats a missing unit as
    // PER_LABEL (no divisor) so their totals stay right.
    // scripts/backfill-label-order-rate-per-k.js converts them.
    //
    // Deliberately no default: a default would make Mongoose hydrate those
    // legacy orders as PER_K and silently restate their rate 1000x. The order
    // create/update path sets it explicitly instead.
    orderRateUnit: { type: String, enum: ["PER_LABEL", "PER_K"] },
    estimatedDate: { type: Date, required: true },
    status: {
      type: String,
      enum: ["PENDING", "CONFIRMED", "DISPATCHED", "DELIVERED", "CANCELLED"],
      default: "PENDING",
    },
    remarks: { type: String, trim: true },
    createdBy: { type: String, default: "SYSTEM" },
    submissionToken: { type: String, trim: true, immutable: true },
    orderSignature: { type: String, trim: true, immutable: true },
  },
  { timestamps: true },
);

labelSalesOrderSchema.index({ status: 1, createdAt: -1 });
labelSalesOrderSchema.index({ userId: 1, status: 1 });
labelSalesOrderSchema.index({ submissionToken: 1 }, { unique: true, sparse: true });
labelSalesOrderSchema.index({ orderSignature: 1 }, { unique: true, sparse: true });

export default mongoose.models.LabelSalesOrder ||
  mongoose.model("LabelSalesOrder", labelSalesOrderSchema, "labelsalesorders");
