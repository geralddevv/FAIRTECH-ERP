import mongoose from "mongoose";

// Master label = product specification only (no client / pricing data).
// A LabelMaster is created once and then bound to client users via the
// Label (binding) model, mirroring the Ttr / TtrBinding pattern.
const labelMasterSchema = new mongoose.Schema(
  {
    labelProductId: { type: String, required: true, unique: true, trim: true },

    /* ================= JOB DETAILS ================= */
    jobType: { type: String, required: true, trim: true },
    jobName: { type: String, trim: true },
    frontColor: { type: String, trim: true },
    backColor: { type: String, trim: true },
    instructions: { type: String, trim: true },
    varnish: { type: String, required: true, trim: true },
    foilNo: { type: String, required: true, trim: true },
    paperType: { type: String, required: true, trim: true },

    /* ================= PRODUCT SPECIFICATIONS ================= */
    labelWidth: { type: String, required: true, trim: true },
    labelHeight: { type: String, required: true, trim: true },
    labelGap: { type: String, required: true, trim: true },
    labelUps: { type: String, required: true, trim: true },
    labelCore: { type: String, required: true, trim: true },
    perRollQty: { type: String, required: true, trim: true },
    firstOut: { type: String, required: true, trim: true },

    /* ================= ATTACHMENTS (stored filenames in images/labels) ================= */
    pdfFile: { type: String, trim: true },
    cdrFile: { type: String, trim: true },
    jpgFile: { type: String, trim: true },
  },
  { timestamps: true },
);

const LabelMaster = mongoose.model("LabelMaster", labelMasterSchema);

export default LabelMaster;
