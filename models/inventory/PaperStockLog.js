import mongoose from "mongoose";

const paperStockLogSchema = new mongoose.Schema(
  {
    paper: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Paper",
      required: true,
      index: true,
    },

    location: {
      type: String,
      required: true,
      index: true,
    },

    openingStock: {
      type: Number,
      required: true,
    },

    quantity: {
      type: Number,
      required: true,
    },

    paperSize: {
      type: Number,
    },

    paperMtrs: {
      type: Number,
    },

    rollId: {
      type: String,
      trim: true,
      uppercase: true,
    },

    // Mirrors PaperStock.vendorRollId -- set on the INWARD line, absent on
    // OUTWARD lines (a deduction or move isn't the vendor telling us anything).
    vendorRollId: {
      type: String,
      trim: true,
    },

    // Mirrors PaperStock.invoiceNo -- same INWARD-only reasoning as vendorRollId.
    invoiceNo: {
      type: String,
      trim: true,
    },

    closingStock: {
      type: Number,
      required: true,
    },

    type: {
      type: String,
      enum: ["INWARD", "OUTWARD"],
      required: true,
    },

    source: {
      type: String,
      enum: ["MANUAL", "SYSTEM"],
      default: "MANUAL",
    },

    remarks: {
      type: String,
      trim: true,
    },

    createdBy: {
      type: String,
      default: "SYSTEM",
    },
  },
  { timestamps: true },
);

export default mongoose.models.PaperStockLog || mongoose.model("PaperStockLog", paperStockLogSchema);
