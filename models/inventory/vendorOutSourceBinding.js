import mongoose from "mongoose";

// Vendor <-> Out Source (finished label) binding. Mirrors VendorTapeBinding,
// but the bound master is a LabelMaster (a finished label made for us by an
// external vendor) rather than a raw-material item. Created from
// /fairtech/form/vendor-item-binding/outsource.
const vendorOutSourceBindingSchema = new mongoose.Schema(
  {
    vendorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "VendorUser",
      required: true,
      index: true,
    },
    // The finished label this vendor is bound to produce (LabelMaster).
    outSourceId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "LabelMaster",
      required: true,
      index: true,
    },
    // The vendor's own code / type for the label (their paperwork's names).
    vendorOutSourcePaperCode: { type: String, required: true, trim: true },
    vendorOutSourcePaperType: { type: String, required: true, trim: true },
    // Location this binding belongs to (one of the vendor user's locationDetails).
    location: { type: String, required: true, trim: true },
    // What the vendor charges and the minimum order they accept.
    outSourceRate: { type: Number },
    outSourceMinQty: { type: Number, required: true },
    status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE" },
  },
  { timestamps: true },
);

vendorOutSourceBindingSchema.index(
  {
    vendorUserId: 1,
    outSourceId: 1,
    vendorOutSourcePaperCode: 1,
    vendorOutSourcePaperType: 1,
    outSourceMinQty: 1,
    location: 1,
  },
  { unique: true },
);

const VendorOutSourceBinding = mongoose.model("VendorOutSourceBinding", vendorOutSourceBindingSchema);
export default VendorOutSourceBinding;
