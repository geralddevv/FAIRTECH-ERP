import mongoose from "mongoose";

const calculatorSchema = new mongoose.Schema({}, { strict: false });
const Calculator = mongoose.model("Calculator", calculatorSchema);

export default Calculator;