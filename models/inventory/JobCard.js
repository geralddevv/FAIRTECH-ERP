import mongoose from "mongoose";

/*
 * Created from the machine queue's "Initiate Production" action
 * (routes/system/machine.js, /machine/jobcard/form). pendingProductionId/
 * machineId are kept for traceability, but every display field is snapshotted
 * as plain text/number at creation time — this is a printed shop-floor
 * document, so it must stay stable even if the source order or machine is
 * later edited or removed.
 */
const jobCardSchema = new mongoose.Schema(
  {
    jobCardId: { type: String, required: true, unique: true },
    date: { type: Date, required: true },
    pendingProductionId: { type: mongoose.Schema.Types.ObjectId, ref: "PendingProduction" },
    machineId: { type: mongoose.Schema.Types.ObjectId, ref: "Machine" },
    machineName: { type: String, trim: true },
    lotNo: { type: String, trim: true },
    productId: { type: String, trim: true },
    labelWidth: { type: String, trim: true },
    labelHeight: { type: String, trim: true },
    dieNo: { type: String, trim: true },
    paperSize: { type: String, trim: true },
    paperType: { type: String, trim: true },
    paperCode: { type: String, trim: true },
    rolls: { type: String, trim: true },
    quantity: { type: Number },
    operatorName: { type: String, trim: true },
    helperName: { type: String, trim: true },
    faceStock: {
      rollDrumNo: { type: String, trim: true },
      code: { type: String, trim: true },
      gsmMic: { type: String, trim: true },
      size: { type: String, trim: true },
    },
    adhesive: {
      rollDrumNo: { type: String, trim: true },
      code: { type: String, trim: true },
      gsmMic: { type: String, trim: true },
      size: { type: String, trim: true },
    },
    releaseLiner: {
      rollDrumNo: { type: String, trim: true },
      code: { type: String, trim: true },
      gsmMic: { type: String, trim: true },
      size: { type: String, trim: true },
    },
    jobSetting: [{
      paperCode: { type: String, trim: true },
      mtrs1:     { type: Number },
      startTime: { type: String, trim: true },
      mtrs2:     { type: Number },
      stopTime:  { type: String, trim: true },
    }],
    productionLog: [{
      deckleId:  { type: String, trim: true },
      meters:    { type: Number },
      face:    { joint: { type: String, trim: true }, mtr: { type: Number } },
      release: { joint: { type: String, trim: true }, mtr: { type: Number } },
      time:    { startTime: { type: String, trim: true }, endTime: { type: String, trim: true } },
    }],
    totalMeter: { type: String, trim: true },
    sqMtr:      { type: String, trim: true },
  },
  { timestamps: true },
);

const JobCard = mongoose.models.JobCard || mongoose.model("JobCard", jobCardSchema, "jobcards");
export default JobCard;
