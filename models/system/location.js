import mongoose from "mongoose";

const locationSchema = new mongoose.Schema(
  {
    locationName: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
    },
    // Not required at the schema level -- this predates the field, so an
    // existing location can be missing it. The form itself requires it (and
    // prefills today's date) for anything created or edited from here on.
    // Stored as the plain "YYYY-MM-DD" the <input type="date"> posts, never
    // parsed into a Date, so display never drifts a day from timezone math.
    date: { type: String, trim: true },
  },
  { timestamps: true },
);

const Location = mongoose.model("Location", locationSchema);
export default Location;
