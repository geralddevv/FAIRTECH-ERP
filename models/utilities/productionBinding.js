import mongoose from "mongoose";

// Mostly schema-less, like Calculator (models/utilities/calculator.js) which
// this was split out of — the Production Binding form's fields vary too much
// to pin down a fixed schema. This collection is now dedicated to Production
// Binding only; Rate Calculator and Sales Calculator still use `calculators`.
//
// userId is declared explicitly (rather than left to strict: false) so it can
// be populated live — the user's name/contact are looked up from the live
// Username doc at render time instead of trusting a stale snapshot.
const productionBindingSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "Username", index: true },
  },
  { strict: false },
);

// Sparse because entries migrated from the old shared `calculators`
// collection (scripts/migrate-calculators-to-production-binding.js) predate
// the duplicate-signature system and won't have a prodSignature value.
productionBindingSchema.index({ prodSignature: 1 }, { unique: true, sparse: true });

const ProductionBinding =
  mongoose.models.ProductionBinding || mongoose.model("ProductionBinding", productionBindingSchema, "productionbindings");

export default ProductionBinding;
