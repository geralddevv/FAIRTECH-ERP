import mongoose from "mongoose";

// Still minimal -- date, size, no. of cylinders and vendor are all that's
// captured until the rest of the real spec fields are known (see the
// Masters > Print Cylinder page comment). There is deliberately no name
// field -- a print cylinder is identified by its date/size/vendor, not a
// label someone types. Extend this schema in place once the rest of the
// spec fields are confirmed; existing documents just gain new blank fields,
// nothing here has to migrate.
//
// NB: this schema used to have a required, unique `printCylinderName`. If
// you ever see a duplicate-key error on that field name again, the index
// wasn't dropped on that database -- see
// scripts/drop-print-cylinder-name-index.js.
const printCylinderSchema = new mongoose.Schema(
  {
    // Not required at the schema level -- see location.js's date comment for
    // why. Stored as the plain "YYYY-MM-DD" the <input type="date"> posts.
    date: { type: String, trim: true },
    size: { type: String, trim: true },
    noOfCylinders: { type: String, trim: true },
    // Free text, not a Vendor ref -- deliberately mirrors the Vendor Master
    // by name only (like Paper's vendorName snapshot), since there's no
    // "PRINT CYLINDER" commodity on Vendor Master to scope a proper binding
    // to yet. The form still sources the dropdown from Vendor Master so
    // names stay consistent, but nothing here is a hard reference.
    vendorName: { type: String, trim: true },
  },
  { timestamps: true },
);

const PrintCylinder = mongoose.model("PrintCylinder", printCylinderSchema);
export default PrintCylinder;
