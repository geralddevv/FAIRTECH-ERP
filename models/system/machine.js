import mongoose from "mongoose";

const machineSchema = new mongoose.Schema(
  {
    machineName: { type: String, required: true, trim: true, uppercase: true },
    location: { type: mongoose.Schema.Types.ObjectId, ref: "Location", required: true, index: true },
  },
  { timestamps: true },
);

machineSchema.index({ machineName: 1, location: 1 }, { unique: true });

const Machine = mongoose.model("Machine", machineSchema);
export default Machine;
