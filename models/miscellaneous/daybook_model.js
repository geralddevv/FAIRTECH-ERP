import mongoose from "mongoose";
import { getTasksConnection } from "../../config/tasksDb.js";

// A Daybook entry is just a "picked for today" pointer onto an existing Task
// — it never copies task data. Entries are scoped to a calendar dayKey, so
// the Daybook page (which only ever queries today's dayKey) naturally shows
// nothing for a past day once the date rolls over: the task "rolls back" to
// being a plain, unpicked task with no separate migration step needed.
const daybookEntrySchema = new mongoose.Schema(
  {
    task: { type: mongoose.Schema.Types.ObjectId, ref: "Task", required: true, index: true },
    dayKey: { type: String, required: true, index: true }, // "YYYY-MM-DD", local calendar day
    createdBy: { type: String, required: true, index: true }, // same ownership convention as Task.createdBy
  },
  { timestamps: true },
);

// Same task can't be picked into the same day's daybook twice.
daybookEntrySchema.index({ dayKey: 1, createdBy: 1, task: 1 }, { unique: true });

// Bound to the isolated tasks database connection, same as Task itself.
const DaybookEntry = getTasksConnection().model("DaybookEntry", daybookEntrySchema);

export default DaybookEntry;
