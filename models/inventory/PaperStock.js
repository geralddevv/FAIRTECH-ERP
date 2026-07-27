import mongoose from "mongoose";

const paperStockSchema = new mongoose.Schema(
  {
    paper: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Paper",
      required: true,
      index: true,
    },

    location: {
      type: String,
      required: true,
      index: true,
    },

    quantity: {
      type: Number,
      required: true,
    },

    paperSize: {
      type: Number,
      required: true,
    },

    paperMtrs: {
      type: Number,
      required: true,
    },

    // System-generated (utils/rollId.js) -- the id on the QR label pasted to
    // the physical reel, and what the job card's Roll ID field is scanned into.
    // Unique, so a scan always names exactly one reel to deduct from.
    rollId: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
      unique: true,
    },

    // Whatever the vendor themselves printed/wrote on the roll -- typed by the
    // operator at inward, kept purely as a cross-reference against the
    // vendor's own paperwork. NOT what identifies the reel in this system (see
    // rollId above): vendor roll numbers legitimately repeat across reels, so
    // this deliberately carries no unique constraint.
    vendorRollId: {
      type: String,
      required: true,
      trim: true,
    },

    remarks: {
      type: String,
      trim: true,
    },
  },
  {
    timestamps: true,
  },
);

// Fast lookup for balance aggregations per paper & location
paperStockSchema.index({ paper: 1, location: 1 });

export default mongoose.models.PaperStock || mongoose.model("PaperStock", paperStockSchema);
