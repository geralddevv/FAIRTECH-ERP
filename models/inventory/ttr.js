import mongoose from "mongoose";

const ttrSchema = new mongoose.Schema(
  {
    /* ================= IDENTIFICATION ================= */
    ttrProductId: {
      type: String, // FS | TTR | 000001
      required: true,
      unique: true,
      trim: true,
    },

    /* ================= PRODUCT DETAILS ================= */
    ttrType: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    ttrColor: {
      type: String,
      required: true,
      enum: ["BLACK", "RED", "GREEN", "BLUE", "YELLOW", "GOLD", "SILVER"],
      default: "BLACK",
      trim: true,
      index: true,
    },

    ttrMaterialCode: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },

    ttrWidth: {
      type: mongoose.Schema.Types.Mixed,
      required: true,
      index: true,
    },

    ttrMtrs: {
      type: Number,
      required: true,
      index: true,
    },

    ttrInkFace: {
      type: String,
      required: true,
      enum: ["OUT"],
      default: "OUT",
    },

    ttrCoreId: {
      type: String,
      required: true,
      enum: ["1", "0.5", "2", '0.5"with extra core'],
    },

    ttrCoreLength: {
      type: Number,
      required: true,
    },

    ttrNotch: {
      type: String,
      required: true,
      enum: ["NO", "YES"],
      default: "NO",
    },

    ttrWinding: {
      type: String,
      required: true,
      enum: ["NORMAL", "LEFT", "CENTER"],
      default: "NORMAL",
    },

    ttrSignature: {
      type: String,
      unique: true,
      sparse: true,
      trim: true,
    },

    ttrMinQty: {
      type: Number,
    },

    /* ================= AUDIT ================= */
    createdBy: {
      type: String,
      default: "SYSTEM",
    },
  },
  {
    timestamps: true,
  },
);

export default mongoose.models.Ttr || mongoose.model("Ttr", ttrSchema);
