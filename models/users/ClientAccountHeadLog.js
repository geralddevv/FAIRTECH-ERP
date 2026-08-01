import mongoose from "mongoose";

// One row per Account Head value a Client Master record has ever carried --
// same "snapshot per change" pattern as SimCardLog (models/hr/SimCardLog.js),
// so /fairtech/client/profile/:id can build a from/to "held by" history the
// same way /fairtech/simcard/profile/:id does.
const clientAccountHeadLogSchema = new mongoose.Schema(
  {
    clientId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Client",
      required: true,
      index: true,
    },

    action: {
      type: String,
      enum: ["SET", "UPDATED"],
      required: true,
    },

    accountHead: { type: String, trim: true, required: true },

    performedBy: { type: String, default: "SYSTEM" },
    performedAt: { type: Date, default: Date.now },
  },
  { timestamps: true },
);

clientAccountHeadLogSchema.index({ clientId: 1, performedAt: -1 });

export default mongoose.models.ClientAccountHeadLog ||
  mongoose.model("ClientAccountHeadLog", clientAccountHeadLogSchema);
