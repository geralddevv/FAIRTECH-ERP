import mongoose from "mongoose";

// Minimal for now -- only a name is captured until the real spec fields are
// known (see the Masters > Anilox page comment). Extend this schema in place
// once they're confirmed; existing documents just gain new blank fields,
// nothing here has to migrate.
const aniloxSchema = new mongoose.Schema(
  {
    aniloxName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
  },
  { timestamps: true },
);

const Anilox = mongoose.model("Anilox", aniloxSchema);
export default Anilox;
