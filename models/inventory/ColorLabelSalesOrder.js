import mongoose from "mongoose";

const colorLabelSalesOrderSchema = new mongoose.Schema(
  {
    colorLabelId: { type: mongoose.Schema.Types.ObjectId, ref: "ColorLabel", required: true, index: true },
    tapeId: { type: mongoose.Schema.Types.ObjectId, ref: "ColorLabel", index: true }, // compat alias
    onModel: { type: String, default: "ColorLabel" },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "Username", required: true, index: true },
    quantity: { type: Number, required: true, min: 1 },
    dispatchedQuantity: { type: Number, default: 0 },
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

colorLabelSalesOrderSchema.index({ status: 1, createdAt: -1 });
colorLabelSalesOrderSchema.index({ userId: 1, status: 1 });
colorLabelSalesOrderSchema.index({ submissionToken: 1 }, { unique: true, sparse: true });
colorLabelSalesOrderSchema.index({ orderSignature: 1 }, { unique: true, sparse: true });

export default mongoose.models.ColorLabelSalesOrder ||
  mongoose.model("ColorLabelSalesOrder", colorLabelSalesOrderSchema, "colorlabelsalesorders");
