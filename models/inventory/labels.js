import mongoose from "mongoose";

let labelSchema = new mongoose.Schema({
  // Reference to the master label this binding was created from.
  labelMasterId: { type: mongoose.Schema.Types.ObjectId, ref: "LabelMaster", index: true },
  productId: { type: String, required: true },
  clientName: { type: String, required: true },
  userName: { type: String, required: true },
  userContact: { type: String, required: true },
  location: { type: String, required: true },
  jobType: { type: String, required: true },
  jobName: { type: String },
//   jobDetail: { type: String, required: true },
  frontColor: { type: String },
  backColor: { type: String },
  instructions: { type: String },
  varnish: { type: String, required: function () { return this.jobType === "COLOR"; } },
  foilNo: { type: String, required: function () { return this.jobType === "COLOR"; } },
  paperType: { type: String, required: true },
  // paperCode: { type: String, required: true },
  labelWidth: { type: String, required: true },
  labelHeight: { type: String, required: true },
  labelGap: { type: String, required: true },
  labelUps: { type: String, required: true },
  labelCore: { type: String, required: true },
  perRollQty: { type: String, required: true },
  firstOut: { type: String, required: function () { return this.jobType === "COLOR"; } },
  ratePerK: { type: String, required: true },
  ratePerLabel: { type: String, required: true },
  perRoll: { type: String, required: true },
  saleCost: { type: String, required: true },
  minOrderQty: { type: String, required: true },
  OrderQty: { type: String },
  repOrderFq: { type: String, required: true },
  creditTerm: { type: String, required: true },
  status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE" },
});

let Label = mongoose.model("Label", labelSchema, "labelsBinding");

export default Label;