import mongoose from "mongoose";

// Out Source finished-label stock, received inward from an external vendor.
// Keyed by master label + location (like TapeStock is keyed by tape + location),
// quantity is a raw label/piece count.
const outsourceStockSchema = new mongoose.Schema(
  {
    master: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LabelMaster",
      required: true,
      index: true,
    },

    location: {
      type: String,
      required: true,
      index: true,
    },

    // Quantity in labels (pieces).
    quantity: {
      type: Number,
      required: true,
    },

    remarks: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);

// Fast lookup for balance aggregations per master & location.
outsourceStockSchema.index({ master: 1, location: 1 });

export default mongoose.models.OutSourceStock || mongoose.model("OutSourceStock", outsourceStockSchema);
