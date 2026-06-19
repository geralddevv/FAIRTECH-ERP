// models/die.model.js
import mongoose from "mongoose";

const DieSchema = new mongoose.Schema({
  dieDate: { type: Date, required: true },
  dieType: { type: String, required: true },
  dieMake: { type: String, required: true },
  dieBladType: { type: String, required: true },
  dieMachineNo: { type: String, required: true },
  dieDieNo: { type: String, required: true },
  dieTeeth: { type: String, required: false }, // magteeth optional
  dieWidth: { type: String, required: true },
  dieHeight: { type: String, required: true },
  dieFlatAcrossGap: { type: String, required: true },
  dieFlatrepGap: { type: String, required: true },
  dieFlatAcross: { type: String, required: true },
  dieFlatDown: { type: String, required: true },
  dieTotalUps: { type: String, required: true },
  diePapType: { type: String, required: true },
  dieStatus: { type: String, required: true },
  blockStatus: { type: String, required: true },
  dieOwnedBy: { type: String, required: true },
  dieClientName: { type: String, required: false }, // client name optional
  dieFlatRemark: { type: String, required: true },
});

let Die = mongoose.model("Die", DieSchema);

export default Die;