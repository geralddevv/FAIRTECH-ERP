import mongoose from "mongoose";

/*
 * Printed rolls waiting to be slit — the first of the two production stages
 * (the slitter turns these into the finished product, see FinishedStock.js).
 *
 * Rolls can only be produced whole, so a job needing 1.2 rolls is run as 2 and
 * the 0.8 left over lands here for a later order of the same spec to draw on
 * instead of producing fresh.
 *
 * Measured in ROLLS — the finished side is measured in labels. Keep the two
 * apart; they are not interchangeable quantities.
 *
 * Keyed by the label item the rolls were printed for, which may be either a
 * Label or a ColorLabel — hence the refPath, matching PendingProduction.
 */
const semiFinishedStockSchema = new mongoose.Schema(
  {
    onModel: { type: String, enum: ["Label", "ColorLabel"], required: true },
    itemId: {
      type: mongoose.Schema.Types.ObjectId,
      required: true,
      refPath: "onModel",
      index: true,
    },

    location: { type: String, required: true, index: true },

    // Rolls physically on hand.
    quantity: { type: Number, required: true, default: 0 },

    // Rolls out of `quantity` already committed to a job. Deliberately NOT
    // derived from the sales-order backlog the way the Tape/Paper stock pages
    // do it — that backlog is denominated in labels and belongs to the finished
    // product, not to rolls sitting in front of the slitter.
    bookedQuantity: { type: Number, required: true, default: 0 },

    remarks: { type: String, trim: true },
  },
  { timestamps: true },
);

// Fast lookup for the per-item balance aggregation on the Assign Production page.
semiFinishedStockSchema.index({ itemId: 1, onModel: 1, location: 1 });

export default mongoose.models.SemiFinishedStock ||
  mongoose.model("SemiFinishedStock", semiFinishedStockSchema, "semifinishedstocks");
