import mongoose from "mongoose";

const machineBindingSchema = new mongoose.Schema(
  {
    machine: { type: mongoose.Schema.Types.ObjectId, ref: "Machine", required: true, index: true },
    die:     { type: mongoose.Schema.Types.ObjectId, ref: "Die" },
    block:   { type: mongoose.Schema.Types.ObjectId, ref: "Block" },
  },
  { timestamps: true },
);

machineBindingSchema.index({ machine: 1, die: 1, block: 1 }, { unique: true });

const MachineBinding = mongoose.model("MachineBinding", machineBindingSchema);
export default MachineBinding;
