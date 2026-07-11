import mongoose from "mongoose";

const simCardSchema = new mongoose.Schema(
  {
    employee: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", default: null },
    employeeName: { type: String, required: true, trim: true },
    isOthers: { type: Boolean, default: false },
    isUnassigned: { type: Boolean, default: false },
    department: { type: String, trim: true, default: "" },
    mobileNumber: { type: String, required: true, trim: true },
    serviceProvider: { type: String, required: true, trim: true },
    tracementService: { type: String, enum: ["YES", "NO"], required: true },
    simCardSignature: { type: String, unique: true, sparse: true, trim: true },
  },
  { timestamps: true }
);

export default mongoose.models.SimCard || mongoose.model("SimCard", simCardSchema);
