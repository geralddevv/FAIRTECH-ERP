import mongoose from "mongoose";

// Mirrors VendorTapeBinding (models/inventory/vendorTapeBinding.js), but for
// LabelMaster -- the reusable label spec catalog -- instead of Tape. This is
// what an outsourced Label binding's vendor is actually bound through (see
// isOutsource on models/inventory/labels.js): one binding here covers every
// client ordering that same LabelMaster spec, the same way one Vendor Tape
// Binding covers every client ordering that same Tape.
const vendorLabelBindingSchema = new mongoose.Schema(
  {
    vendorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "VendorUser",
      required: true,
      index: true,
    },
    labelMasterId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LabelMaster",
      required: true,
      index: true,
    },
    vendorLabelPaperCode: { type: String, required: true, trim: true },
    vendorLabelPaperType: { type: String, required: true, trim: true },
    // Location this binding belongs to (one of the vendor user's locationDetails).
    location: { type: String, required: true, trim: true },
    labelRatePerK: { type: Number },
    labelMinQty: { type: Number, required: true },
    labelOdrQty: { type: Number },
    labelOdrFreq: { type: String, trim: true },
    labelCreditTerm: { type: String, trim: true },
    status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE" },
  },
  { timestamps: true },
);

vendorLabelBindingSchema.index(
  {
    vendorUserId: 1,
    labelMasterId: 1,
    vendorLabelPaperCode: 1,
    vendorLabelPaperType: 1,
    labelMinQty: 1,
    location: 1,
  },
  { unique: true },
);

const VendorLabelBinding = mongoose.model("VendorLabelBinding", vendorLabelBindingSchema);
export default VendorLabelBinding;
