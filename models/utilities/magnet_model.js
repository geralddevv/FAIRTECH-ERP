import mongoose from "mongoose";

// Same shape as Print Cylinder (models/utilities/printCylinder_model.js) --
// name, size and vendor are all that's captured until the rest of the real
// spec fields are known. Extend this schema in place once they're confirmed.
const magnetSchema = new mongoose.Schema(
  {
    magnetName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    size: { type: String, trim: true },
    // Free text, not a Vendor ref -- see printCylinder_model.js's comment on
    // the same field for why.
    vendorName: { type: String, trim: true },
    // Not required at the schema level -- see location.js's date comment for
    // why. Stored as the plain "YYYY-MM-DD" the <input type="date"> posts.
    date: { type: String, trim: true },
  },
  { timestamps: true },
);

const Magnet = mongoose.model("Magnet", magnetSchema);
export default Magnet;
