import mongoose from "mongoose";

const vendorTtrBindingSchema = new mongoose.Schema(
  {
    vendorUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "VendorUser",
      required: true,
      index: true,
    },
    ttrId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Ttr",
      required: true,
      index: true,
    },

    vendorTtrMaterialCode: {
      type: String,
      required: true,
      trim: true,
    },
    vendorTtrType: {
      type: String,
      enum: [
        "WAX",
        "WAX PREMIUM",
        "WAX COLOR",
        "WAX RESIN",
        "WAX RESIN PREMIUM",
        "WAX RESIN COLOR",
        "RESIN",
        "RESIN COLOR",
        "SCRATCH PROOF",
        "WASHCARE",
        "TTO",
      ],
      required: true,
      trim: true,
    },
    vendorTtrColor: {
      type: String,
      required: true,
      trim: true,
    },
    ttrMtrsDel: {
      type: String,
      required: true,
      trim: true,
    },

    ttrRatePerRoll: {
      type: Number,
      required: true,
      min: 0,
    },
    ttrSaleCost: {
      type: Number,
      required: true,
      min: 0,
    },
    ttrMinQty: {
      type: Number,
      required: true,
      min: 0,
    },
    ttrOdrQty: {
      type: Number,
      required: true,
      min: 0,
    },
    ttrOdrFreq: {
      type: String,
      required: true,
      trim: true,
    },
    ttrCreditTerm: {
      type: String,
      required: true,
      trim: true,
    },

    status: {
      type: String,
      enum: ["ACTIVE", "INACTIVE"],
      default: "ACTIVE",
    },
  },
  {
    timestamps: true,
  },
);

vendorTtrBindingSchema.index({ vendorUserId: 1, ttrId: 1 }, { unique: true });
vendorTtrBindingSchema.index({ vendorTtrMaterialCode: 1 });

const VendorTtrBinding = mongoose.model("VendorTtrBinding", vendorTtrBindingSchema);

export default VendorTtrBinding;
