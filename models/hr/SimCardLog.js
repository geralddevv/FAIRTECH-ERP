import mongoose from "mongoose";

const simCardLogSchema = new mongoose.Schema(
  {
    simCardId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "SimCard",
      required: true,
      index: true,
    },

    action: {
      type: String,
      enum: ["ASSIGNED", "UPDATED", "REMOVED"],
      required: true,
    },

    employeeName: { type: String, trim: true },
    department: { type: String, trim: true },
    mobileNumber: { type: String, trim: true },
    serviceProvider: { type: String, trim: true },
    tracementService: { type: String, trim: true },

    performedBy: { type: String, default: "SYSTEM" },
    performedAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

simCardLogSchema.index({ simCardId: 1, performedAt: -1 });

export default mongoose.models.SimCardLog || mongoose.model("SimCardLog", simCardLogSchema);
