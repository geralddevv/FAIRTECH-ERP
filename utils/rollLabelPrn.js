// TSPL (TSC Printer Language) print job for one paper reel's label.
//
// The physical label stock is pre-printed: the boxes, grid lines and field
// captions ("CLIENT NAME", "ITEM CODE", "ROLL ID", etc.) are already on the
// blank label. This print job only lays down the two things that change per
// reel -- the Roll ID text and its QR code -- at the coordinates that land
// inside the pre-printed "ROLL ID" box and QR box on FAIRTECH's label design
// (matched to the working .prn FAIRTECH already prints from; everything else
// in that file -- the BOX/BAR grid lines and the other TEXT captions -- is
// the pre-printed part and is deliberately left out here).
//
// The QR payload is "rollId vendorRollId paperSize paperMtrs", matching
// FAIRTECH's original label design. The job card still scans this straight
// into its Roll ID field, so it has to keep working with the whole string
// landing there, not just the id -- see utils/rollId.js's
// extractScannedRollId (pulls the first token back out for matching) and its
// use in routes/system/machine.js's consumeAllottedRollMeters and the client
// copy in views/inventory/masters/jobCardForm.ejs.
//
// Placement is exported as constants (not inlined below) so
// views/stock/paperRollLabel.ejs's on-screen preview can position its Roll ID
// text and QR at the exact same coordinates instead of a second, hand-copied
// set of numbers that could quietly drift out of sync with this file.
export const LABEL_WIDTH_MM = 101.5;
export const LABEL_HEIGHT_MM = 75.1;

// 8 dots/mm (203 dpi), derived from this printer's own working label: the
// full .prn FAIRTECH printed from before also carried
// `BOX 31,17,776,582,2` -- the pre-printed grid's outer border. At 8 dots/mm
// that box's far corner (776, 582 dots = 97.0, 72.75 mm) sits a plausible
// ~4.5 mm / ~2.35 mm inside the 101.5 x 75.1 mm label edge. A 300 dpi
// (11.8 dots/mm) reading would put over 35 mm of margin on the right edge
// alone, which the label clearly doesn't have.
export const DOTS_PER_MM = 8;

// Bottom-right placement. Rotation is 180 for both, and each element's own
// anchor is its rendered BOTTOM-RIGHT corner (a 180-degree rotation around a
// point maps that point's original top-left to become its bottom-right) --
// so anchoring the text near the label's right edge and the QR near its
// bottom edge, with a clean 40-dot (5 mm) margin, puts the pair snug in that
// corner with nothing hanging off either edge.
//
// The two anchors keep the exact relationship from FAIRTECH's original
// working label (TEXT 548,93 / QRCODE 143,113 there): text sits 405 dots
// right of and 20 dots above the QR -- same numbers, just the whole pair
// translated as a rigid group instead of relaid-out from scratch.
const LABEL_WIDTH_DOTS = LABEL_WIDTH_MM * DOTS_PER_MM; // 812
const LABEL_HEIGHT_DOTS = Math.round(LABEL_HEIGHT_MM * DOTS_PER_MM); // 601
const CORNER_MARGIN_DOTS = 40; // 5 mm
const TEXT_QR_DX_DOTS = 548 - 143; // 405 -- text is this far right of the QR
const TEXT_QR_DY_DOTS = 93 - 113; // -20 -- text is this far above the QR

export const TEXT_X_DOTS = LABEL_WIDTH_DOTS - CORNER_MARGIN_DOTS; // 772
export const TEXT_ROTATION_DEG = 180;

export const QR_Y_DOTS = LABEL_HEIGHT_DOTS - CORNER_MARGIN_DOTS; // 561
export const QR_X_DOTS = TEXT_X_DOTS - TEXT_QR_DX_DOTS; // 367
export const TEXT_Y_DOTS = QR_Y_DOTS + TEXT_QR_DY_DOTS; // 541
export const QR_ROTATION_DEG = 180;
// Dots per QR module ("cell width" in the QRCODE command) and the error
// correction level the printer's own QR encoder uses -- both feed the
// preview's box size (module count x QR_CELL_WIDTH_DOTS), so it isn't just
// positioned right but sized right too.
export const QR_CELL_WIDTH_DOTS = 3;
export const QR_ECC_LEVEL = "L";

// TSPL strings are double-quote delimited; a stray quote in any field would
// corrupt the command. rollId is system-generated and never carries one;
// vendorRollId is operator-typed, so it's stripped defensively rather than
// trusted. paperSize/paperMtrs are numbers -- nothing to strip.
const sanitizeField = (value) => String(value ?? "").replace(/"/g, "");

// Shared by buildRollLabelPrn (the actual QR content) and the caller that
// sizes the on-screen preview's QR box (routes/stock/paperStock.js) -- the
// module count, and so the physical size, depends on the full payload
// length, not just the Roll ID, so both need the exact same string.
export function buildQrPayload({ rollId, vendorRollId, paperSize, paperMtrs }) {
  return [
    sanitizeField(rollId),
    sanitizeField(vendorRollId),
    sanitizeField(paperSize),
    sanitizeField(paperMtrs),
  ].join(" ");
}

export function buildRollLabelPrn({ rollId, vendorRollId, paperSize, paperMtrs }) {
  const id = sanitizeField(rollId);
  const qrPayload = buildQrPayload({ rollId, vendorRollId, paperSize, paperMtrs });

  return [
    `SIZE ${LABEL_WIDTH_MM} mm, ${LABEL_HEIGHT_MM} mm`,
    "GAP 3 mm, 0 mm",
    "SPEED 4",
    "DENSITY 10",
    "SET RIBBON ON",
    "DIRECTION 0,0",
    "REFERENCE 0,0",
    "OFFSET 0 mm",
    "SET PEEL OFF",
    "SET CUTTER OFF",
    "SET PARTIAL_CUTTER OFF",
    "SET TEAR ON",
    "CLS",
    "CODEPAGE 1252",
    // The visible TEXT stays just the Roll ID -- only the QR carries the
    // fuller payload.
    `TEXT ${TEXT_X_DOTS},${TEXT_Y_DOTS},"0",${TEXT_ROTATION_DEG},16,16,"${id}"`,
    `QRCODE ${QR_X_DOTS},${QR_Y_DOTS},${QR_ECC_LEVEL},${QR_CELL_WIDTH_DOTS},A,${QR_ROTATION_DEG},M2,S7,"${qrPayload}"`,
    "PRINT 1,1",
    "",
  ].join("\r\n");
}

// A filesystem-safe name for the download -- rollId's slashes (C011/26-27/002)
// aren't legal in a filename.
export function rollLabelPrnFilename(rollId) {
  const safe = String(rollId ?? "roll").replace(/[\\/:*?"<>|]+/g, "-");
  return `${safe}.prn`;
}
