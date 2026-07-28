import mongoose from "mongoose";

// Mostly schema-less, like Calculator (models/utilities/calculator.js) which
// this was split out of — the Production Binding form's fields vary too much
// to pin down a fixed schema. This collection is now dedicated to Production
// Binding only; Rate Calculator and Sales Calculator still use `calculators`.
//
// userId is declared explicitly (rather than left to strict: false) so it can
// be populated live — the user's name/contact are looked up from the live
// Username doc at render time instead of trusting a stale snapshot.
//
// paperId is the same idea, for the paper spec: prodVendorName/prodPaperCode/
// prodPaperFamily/prodPaperRate are still plain free-text snapshot fields
// (set at bind time, or resolved into the form from Paper Master at that
// moment), but paperId is a real reference to the Paper document they were
// resolved from. Routes that display prodPaperRate look this up and show
// Paper's *current* rate when paperId is present, falling back to the stored
// snapshot for older bindings that predate this field. Edits to the Paper
// Master's rate are therefore reflected here without needing another
// one-time fix script each time.
const productionBindingSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "Username", index: true },
    paperId: { type: mongoose.Schema.Types.ObjectId, ref: "Paper", index: true },
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
