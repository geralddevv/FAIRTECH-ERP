import mongoose from "mongoose";

// Still minimal -- name, size, vendor, qty and date are all that's captured
// until the rest of the real spec fields are known (see the Masters > Print
// Cylinder page comment). Extend this schema in place once they're
// confirmed; existing documents just gain new blank fields, nothing here has
// to migrate.
const printCylinderSchema = new mongoose.Schema(
  {
    printCylinderName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    size: { type: String, trim: true },
    qty: { type: String, trim: true },
    // Free text, not a Vendor ref -- deliberately mirrors the Vendor Master
    // by name only (like Paper's vendorName snapshot), since there's no
    // "PRINT CYLINDER" commodity on Vendor Master to scope a proper binding
    // to yet. The form still sources the dropdown from Vendor Master so
    // names stay consistent, but nothing here is a hard reference.
    vendorName: { type: String, trim: true },
    // Not required at the schema level -- see location.js's date comment for
    // why. Stored as the plain "YYYY-MM-DD" the <input type="date"> posts.
    date: { type: String, trim: true },
  },
  { timestamps: true },
);

const PrintCylinder = mongoose.model("PrintCylinder", printCylinderSchema);
export default PrintCylinder;
