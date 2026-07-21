import mongoose from "mongoose";

/*
 * Movement history for FinishedStock — same shape as TapeStockLog so the stock
 * pages' opening/closing audit trail reads the same way across item types.
 * Quantities are in LABELS.
 */
const finishedStockLogSchema = new mongoose.Schema(
  {
    onModel: { type: String, enum: ["Label", "ColorLabel"], required: true },
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      refPath: "onModel",
      index: true,
    },

    location: { type: String, required: true, index: true },

    openingStock: { type: Number, required: true },
    quantity: { type: Number, required: true },
    closingStock: { type: Number, required: true },

    type: { type: String, enum: ["INWARD", "OUTWARD"], required: true },
    source: { type: String, enum: ["MANUAL", "SYSTEM"], default: "MANUAL" },

    remarks: { type: String, trim: true },
    createdBy: { type: String, default: "SYSTEM" },
  },
  { timestamps: true },
);

export default mongoose.models.FinishedStockLog ||
  mongoose.model("FinishedStockLog", finishedStockLogSchema, "finishedstocklogs");
