// The ONE definition of the Margin % colour bands -- see "Margin % colour
// bands" in CLAUDE.md. server.js exposes MARGIN_BANDS as an app local, and
// layout/boilerplate.ejs writes it into window.MARGIN_BANDS for the views'
// client-side marginBandClass(); the server uses marginBandClass() below
// directly (e.g. /prodcalc/view filtering the "sales" role to critical rows).
//
// Bands are upper-INCLUSIVE and checked in order: <=1.3 red,
// >1.3 to <=1.4 yellow, >1.4 to <=1.5 green, >1.5 white.
export const MARGIN_BANDS = [
  { max: 1.3, cls: "row-margin-red" },
  { max: 1.4, cls: "row-margin-yellow" },
  { max: 1.5, cls: "row-margin-green" },
];

export const CRITICAL_MARGIN_CLASS = "row-margin-red";

// Same logic as window.marginBandClass in layout/boilerplate.ejs. Returns ""
// when there is no usable margin. parseFloat, not Number: these values are
// stored as strings and Number("") === 0 would read an unknown margin as red.
export function marginBandClass(value) {
  const pct = parseFloat(value);
  if (!Number.isFinite(pct)) return "";
  for (const band of MARGIN_BANDS) {
    if (pct <= band.max) return band.cls;
  }
  return "row-margin-white";
}
