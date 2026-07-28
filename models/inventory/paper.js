import mongoose from "mongoose";

// Paper master = raw-material spec only (no quantity). Quantity is tracked
// separately in PaperStock, mirroring the Tape / TapeStock pattern.
// vendorName is expected to come from the Vendor master, scoped to vendors
// whose commodities include "SL (PAPER)" (see routes/stock/paperStock.js and
// the existing /form/prodcalc route, which uses the same scoping).
const paperSchema = new mongoose.Schema(
  {
    paperProductId: { type: String, required: true, unique: true, trim: true },
    vendorName: { type: String, required: true, trim: true, index: true },
    prodCode: { type: String, required: true, trim: true, index: true },
    rate: { type: Number, required: true }, // last rate (i.e. current rate)
    // previousRate/minRate/maxRate are shifted forward whenever rate changes
    // (see routes/stock/paperStock.js's POST /create and
    // routes/fairdesk_route.js's PUT /paper/:id) -- previousRate is whatever
    // rate held just before the latest change; minRate/maxRate are the
    // lowest/highest rate ever recorded for this paper ("Lowest"/"Highest" on
    // the Paper Master table).
    previousRate: { type: Number },
    minRate: { type: Number },
    maxRate: { type: Number },
    family: { type: String, required: true, trim: true, index: true },
    paperSignature: { type: String, unique: true, sparse: true, trim: true },
    status: { type: String, enum: ["ACTIVE", "INACTIVE"], default: "ACTIVE" },
    // Stored filename (on disk under images/papers) of an optional datasheet
    // attachment (PDF or image). Served via GET /fairtech/paper/file/:id.
    datasheet: { type: String, trim: true },
    createdBy: { type: String, default: "SYSTEM" },
  },
  { timestamps: true },
);

export default mongoose.models.Paper || mongoose.model("Paper", paperSchema, "papers");
