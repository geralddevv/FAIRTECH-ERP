import mongoose from "mongoose";

const colorLabelMasterSchema = new mongoose.Schema(
  {
    labelProductId: { type: String, required: true, unique: true, trim: true },

    jobType: { type: String, default: "COLOR", trim: true },
    jobName: { type: String, trim: true },
    frontColor: { type: String, trim: true },
    backColor: { type: String, trim: true },
    varnish: { type: String, trim: true },
    foilNo: { type: String, trim: true },
    firstOut: { type: String, trim: true },
    labelFamily: { type: String, trim: true },
    paperType: { type: String, trim: true },
    paperCode: { type: String, trim: true },

    labelWidth: { type: String, required: true, trim: true },
    labelHeight: { type: String, required: true, trim: true },
    labelGap: { type: String, required: true, trim: true },
    labelUps: { type: String, trim: true },
    labelCore: { type: String, trim: true },
    perRollQty: { type: String, trim: true },
    labelSignature: { type: String, unique: true, sparse: true, trim: true },
    status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE" },

    pdfFile: { type: String, trim: true },
    cdrFile: { type: String, trim: true },
    jpgFile: { type: String, trim: true },
  },
  { timestamps: true },
);

const ColorLabelMaster = mongoose.models.ColorLabelMaster ||
  mongoose.model("ColorLabelMaster", colorLabelMasterSchema, "colorlabels");

export default ColorLabelMaster;
