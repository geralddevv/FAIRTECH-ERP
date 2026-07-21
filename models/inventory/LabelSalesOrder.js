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
