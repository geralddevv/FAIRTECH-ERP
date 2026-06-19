import mongoose from "mongoose";

let careleadSchema = new mongoose.Schema({}, {strict: false});
let Carelead = mongoose.model("Carelead", careleadSchema);

export default Carelead;