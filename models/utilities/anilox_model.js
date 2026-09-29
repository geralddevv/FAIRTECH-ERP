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
    // Not required at the schema level -- see location.js's date comment for
    // why. Stored as the plain "YYYY-MM-DD" the <input type="date"> posts.
    date: { type: String, trim: true },
  },
  { timestamps: true },
);

const Anilox = mongoose.model("Anilox", aniloxSchema);
export default Anilox;
