import mongoose from "mongoose";

const taskSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    // Every task has exactly one responsible employee.
    assignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "Employee", required: true, index: true },
    // Optional — a task doesn't have to be tied to a client/company.
    client: { type: mongoose.Schema.Types.ObjectId, ref: "Client", index: true },
    dueDate: { type: Date },
    status: {
      type: String,
      enum: ["PENDING", "IN_PROGRESS", "COMPLETED"],
      default: "PENDING",
      index: true,
    },
    createdBy: { type: String, trim: true },
  },
  { timestamps: true },
);

const Task = mongoose.model("Task", taskSchema);

export default Task;
