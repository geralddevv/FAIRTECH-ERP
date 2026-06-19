import mongoose from "mongoose";
const { Schema } = mongoose;

const vendorUserSchema = new mongoose.Schema({
  vendorId: { type: String, required: true },
  vendorName: { type: String, required: true },
  hoLocation: { type: String, required: true },
  warehouseLocation: { type: String, required: true },
  userName: { type: String, required: true },
  userLocation: { type: String, required: true },
  userDepartment: { type: String, required: true },
  userContact: { type: String, required: true },
  userEmail: { type: String, required: true },
  locationsCount: { type: Number, default: 1 },
  locationDetails: [
    {
      userLocation: { type: String },
      dispatchAddress: { type: String },
    },
  ],
  dispatchAddress: { type: String, required: true },
  transportName: { type: String },
  transportContact: { type: String },
  dropLocation: { type: String },
  dropLocation1: { type: String },
  deliveryMode: { type: String },
  deliveryLocation: { type: String },
  deliveryLocation1: { type: String },
  vendorPayment: { type: String },
  SelfDispatch: { type: String },
  vendorStatus: { type: String },
  ownerName: { type: String },
  ownerMobNo: { type: String },
  ownerEmail: { type: String },
  vendorGst: { type: String },
  vendorMsme: { type: String },
  commodities: [String],
  vendorUserSignature: { type: String, unique: true, sparse: true, trim: true },

  ttr: [
    {
      type: Schema.Types.ObjectId,
      ref: "VendorTtrBinding",
    },
  ],

  tape: [
    {
      type: Schema.Types.ObjectId,
      ref: "VendorTapeBinding",
    },
  ],

  posRoll: [
    {
      type: Schema.Types.ObjectId,
      ref: "VendorPosRollBinding",
    },
  ],

  tafeta: [
    {
      type: Schema.Types.ObjectId,
      ref: "VendorTafetaBinding",
    },
  ],

  // Multiple label per vendor (future-proof)
  label: [
    {
      type: Schema.Types.ObjectId,
      ref: "Label",
    },
  ],
});

const VendorUser = mongoose.model("VendorUser", vendorUserSchema);

export default VendorUser;
