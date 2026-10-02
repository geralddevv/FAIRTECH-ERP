import { fileURLToPath } from "url";
import path from "path";
import dotenv from "dotenv";
dotenv.config({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".env") });
import mongoose from "mongoose";
import connectDB from "../config/db.js";
import Label from "../models/inventory/labels.js";
import Username from "../models/users/username.js";

// ---------------------------------------------------------------------------
// Find Label bindings (/fairtech/labels-binding/edit/:id) whose Width or
// Height is given in inches (e.g. 4") but have no Width (mm) / Height (mm)
// recorded.
//
// That mm field is what prodCalc.ejs's Production Binding form actually
// matches a die against (dies are stored in mm) -- see dieWidth/dieHeight in
// views/utilities/prodCalc.ejs. It used to only show (and so could only ever
// be filled in) when the label's own size was in inches; it's now always
// available, because the same mismatch happens even when Width/Height is a
// plain number -- a customer orders 102x102mm, the nearest matching master is
// 100x100, and without recording the real 102x102 the die gets matched to the
// wrong size.
//
// There is NO reliable formula to backfill these from the inches value alone.
// Most existing records happen to follow inches x 25 (4" -> 100, 6" -> 150),
// but it is not a rule -- at least one real binding in this database has
// 6" -> 100mm, not 150mm, because that is the die actually on hand. Treat the
// x25 figure printed below as a hint to go confirm, never as the answer.
//
// Every binding this finds needs a human decision (the real mm size, checked
// against the die or the customer), so unlike other fix-*.js scripts here,
// plain --apply never writes anything by itself.
//
//   node scripts/fix-label-missing-mm-size.js                                   # report
//   node scripts/fix-label-missing-mm-size.js --id=<id> --widthMm=100 --heightMm=150 --apply
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const idArg = args.find((a) => a.startsWith("--id="));
const widthArg = args.find((a) => a.startsWith("--widthMm="));
const heightArg = args.find((a) => a.startsWith("--heightMm="));
const ONLY_ID = idArg ? idArg.slice("--id=".length).trim() : null;
const FORCE_WIDTH_MM = widthArg ? widthArg.slice("--widthMm=".length).trim() : null;
const FORCE_HEIGHT_MM = heightArg ? heightArg.slice("--heightMm=".length).trim() : null;

if ((FORCE_WIDTH_MM || FORCE_HEIGHT_MM) && !ONLY_ID) {
  console.error("--widthMm=/--heightMm= need --id=<binding id>: they set one binding's size explicitly.");
  process.exit(1);
}
if (APPLY && ONLY_ID && !FORCE_WIDTH_MM && !FORCE_HEIGHT_MM) {
  console.error("--id= with --apply needs at least one of --widthMm= / --heightMm= to write.");
  process.exit(1);
}

const parseInches = (value) => {
  const m = String(value || "").match(/^([\d.]+)"$/);
  return m ? Number(m[1]) : null;
};

await connectDB();

const query = {};
if (ONLY_ID) {
  if (!mongoose.isValidObjectId(ONLY_ID)) {
    console.error(`Not a valid binding id: ${ONLY_ID}`);
    process.exit(1);
  }
  query._id = new mongoose.Types.ObjectId(ONLY_ID);
}

const bindings = await Label.find(query)
  .select("productId jobName labelWidth labelHeight labelWidthMm labelHeightMm")
  .lean();

const affected = bindings.filter((b) => {
  const widthMissing = parseInches(b.labelWidth) !== null && !String(b.labelWidthMm || "").trim();
  const heightMissing = parseInches(b.labelHeight) !== null && !String(b.labelHeightMm || "").trim();
  return widthMissing || heightMissing;
});

if (affected.length === 0) {
  console.log(ONLY_ID ? "That binding already has mm recorded for every inches dimension it has." : "No label bindings need an mm size.");
  await mongoose.disconnect();
  process.exit(0);
}

let fixed = 0;
let needsDecision = 0;

for (const binding of affected) {
  const owner = await Username.findOne({ label: binding._id }).select("clientName userName userLocation").lean();
  const who = owner ? `${owner.clientName} / ${owner.userName} (${owner.userLocation || "no location"})` : "(no owning user found)";
  const widthIn = parseInches(binding.labelWidth);
  const heightIn = parseInches(binding.labelHeight);

  console.log(`${binding._id}  ${binding.productId || "-"}  ${binding.jobName || "-"}`);
  console.log(`  owner          : ${who}`);
  console.log(`  width          : ${binding.labelWidth}${widthIn !== null && !binding.labelWidthMm ? `  (no mm saved -- common convention would be ${widthIn * 25}, CONFIRM before using)` : ""}`);
  console.log(`  height         : ${binding.labelHeight}${heightIn !== null && !binding.labelHeightMm ? `  (no mm saved -- common convention would be ${heightIn * 25}, CONFIRM before using)` : ""}`);

  if (ONLY_ID && (FORCE_WIDTH_MM || FORCE_HEIGHT_MM)) {
    const update = {};
    if (FORCE_WIDTH_MM) update.labelWidthMm = FORCE_WIDTH_MM;
    if (FORCE_HEIGHT_MM) update.labelHeightMm = FORCE_HEIGHT_MM;
    console.log(`  --> ${APPLY ? "set" : "would set"} ${Object.entries(update).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    if (APPLY) {
      await Label.updateOne({ _id: binding._id }, { $set: update });
    }
    fixed++;
  } else {
    console.log(`  --> NEEDS A DECISION: confirm the real mm size (with the die, or the customer), then re-run with`);
    console.log(`      --id=${binding._id} --widthMm=<mm> --heightMm=<mm> --apply`);
    needsDecision++;
  }
  console.log("");
}

console.log(`${affected.length} binding(s) missing an mm size: ${fixed} ${APPLY ? "set" : "would be set"}, ${needsDecision} still need a decision.`);
if (!APPLY && fixed > 0) console.log("Dry run -- re-run with --apply to write.");

await mongoose.disconnect();
