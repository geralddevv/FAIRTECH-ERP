import mongoose from "mongoose";

const paperStockSchema = new mongoose.Schema(
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

// Fast lookup for balance aggregations per paper & location
paperStockSchema.index({ paper: 1, location: 1 });

export default mongoose.models.PaperStock || mongoose.model("PaperStock", paperStockSchema);
