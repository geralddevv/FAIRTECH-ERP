import mongoose from "mongoose";

const ttrBindingSchema = new mongoose.Schema(
  {
    /* ================= REFERENCES ================= */
    ttrId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Ttr",
      required: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Username",
      required: true,
      index: true,
    },

    /* ================= CLIENT OVERRIDES ================= */
    ttrClientMaterialCode: {
      type: String,
      required: true,
      trim: true,
    },
    clientTtrType: {
      type: String,
      required: true,
      trim: true,
    },
    ttrMtrsDel: {
      type: String,
      required: true,
      trim: true,
    },

    /* ================= PRICING & COST ================= */
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

    /* ================= ORDER TERMS ================= */
    ttrMinQty: {
      type: Number,
      required: true,
      min: 1,
    },
    ttrOdrQty: {
      type: Number,
      required: true,
      min: 1,
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

    /* ================= STATUS ================= */
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

/* Ensure a user can only be bound to a specific TTR master once */
ttrBindingSchema.index({ userId: 1, ttrId: 1 }, { unique: true });

const TtrBinding = mongoose.model("TtrBinding", ttrBindingSchema);
export default TtrBinding;
