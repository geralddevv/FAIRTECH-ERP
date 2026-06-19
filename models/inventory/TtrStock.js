import mongoose from "mongoose";

const ttrStockSchema = new mongoose.Schema(
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

// Fast lookup for balance aggregations per ttr & location
ttrStockSchema.index({ ttr: 1, location: 1 });

/* ================= EXPORT ================= */
export default mongoose.models.TtrStock || mongoose.model("TtrStock", ttrStockSchema);
