import mongoose from "mongoose";

const ttrStockLogSchema = new mongoose.Schema(
  {
    ttr: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Ttr",
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

export default mongoose.model("TtrStockLog", ttrStockLogSchema);
