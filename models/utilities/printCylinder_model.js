import mongoose from "mongoose";

// Minimal for now -- only a name is captured until the real spec fields are
// known (see the Masters > Print Cylinder page comment). Extend this schema
// in place once they're confirmed; existing documents just gain new blank
// fields, nothing here has to migrate.
const printCylinderSchema = new mongoose.Schema(
  {
    printCylinderName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
  },
  { timestamps: true },
);

const PrintCylinder = mongoose.model("PrintCylinder", printCylinderSchema);
export default PrintCylinder;
