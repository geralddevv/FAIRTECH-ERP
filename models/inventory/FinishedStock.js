import mongoose from "mongoose";

/*
 * The slit, finished product — the second production stage, fed by
 * SemiFinishedStock.js.
 *
 * Measured in LABELS — the semi finished side is measured in rolls. Keep the
 * two apart; they are not interchangeable quantities.
 *
 * Keyed by the label item, which may be either a Label or a ColorLabel — hence
 * the refPath, matching PendingProduction.
 */
const finishedStockSchema = new mongoose.Schema(
  {
    onModel: { type: String, enum: ["Label", "ColorLabel"], required: true },
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      refPath: "onModel",
      index: true,
    },

    location: { type: String, required: true, index: true },

    // Labels physically on hand.
    quantity: { type: Number, required: true, default: 0 },

    // Labels out of `quantity` already committed. Deliberately NOT derived from
    // the sales-order backlog the way the Tape/Paper stock pages do it — this
    // is stock genuinely set aside, not everything customers have on order.
    bookedQuantity: { type: Number, required: true, default: 0 },

    remarks: { type: String, trim: true },
  },
  { timestamps: true },
);

// Fast lookup for the per-item balance aggregation on the Assign Production page.
finishedStockSchema.index({ itemId: 1, onModel: 1, location: 1 });

export default mongoose.models.FinishedStock ||
  mongoose.model("FinishedStock", finishedStockSchema, "finishedstocks");
