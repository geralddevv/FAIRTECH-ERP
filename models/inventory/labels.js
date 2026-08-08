import mongoose from "mongoose";

let labelSchema = new mongoose.Schema({
  // Reference to the master label this binding was created from.
  labelMasterId: { type: mongoose.Schema.Types.ObjectId, ref: "LabelMaster", index: true },
  // Live reference to the owning user — clientName/userName/userContact below
  // are a denormalized snapshot kept for legacy readers; prefer populating
  // userId for anything that needs current values.
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "Username", index: true },
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
  labelFamily: { type: String },
  clientSkuCode: { type: String },
  clientInstructions: { type: String },
  vendorName: { type: String },
  // NB: whether a label is outsourced is NOT recorded here -- it's a property
  // of how the job is produced, so it lives on the Production Binding
  // (isOutsource in models/utilities/productionBinding.js, set on
  // /fairtech/form/prodcalc). This form stays purely about the client's side
  // of the binding.
  paperType: { type: String },
  paperCode: { type: String },
  labelWidth: { type: String, required: true },
  labelHeight: { type: String, required: true },
  // Manually-entered mm equivalents, only captured when the master size is
  // given in inches (its width/height carries a " ). Not auto-converted.
  labelWidthMm: { type: String },
  labelHeightMm: { type: String },
  labelGap: { type: String, required: true },
  labelUps: { type: String, required: true },
  labelCore: { type: String, required: true },
  perRollQty: { type: String },
  firstOut: { type: String, required: function () { return this.jobType === "COLOR"; } },
  ratePerK: { type: String, required: true },
  // Sales commission deducted per 1000 labels; ratePerLabel (and everything
  // derived from it -- perRoll, saleCost, and downstream margin calcs on the
  // Production Calculator) is computed from (ratePerK - commissionPerK), not
  // ratePerK alone.
  commissionPerK: { type: String, default: "0" },
  // How the commission was entered: a flat amount ("VALUE") or a percentage of
  // ratePerK ("PERCENT"). `commissionValue` keeps the raw number the user typed
  // so the form can round-trip it on edit; `commissionPerK` above always stays
  // the resolved absolute amount per 1000 that every downstream calc reads.
  commissionMode: { type: String, enum: ["VALUE", "PERCENT"], default: "VALUE" },
  commissionValue: { type: String, default: "0" },
  ratePerLabel: { type: String, required: true },
  perRoll: { type: String, required: true },
  saleCost: { type: String, required: true },
  minOrderQty: { type: String, required: true },
  // Unit the minimum order quantity is expressed in.
  moqUnit: { type: String, enum: ["LABELS", "ROLLS"], default: "LABELS" },
  OrderQty: { type: String },
  repOrderFq: { type: String, required: true },
  creditTerm: { type: String, required: true },
  billingType: { type: String, enum: ["ROLLS", "LABELS"], required: true },
  labelsDel: { type: String },
  status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE" },
});

let Label = mongoose.model("Label", labelSchema, "labelsBinding");

export default Label;