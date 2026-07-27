import QRCode from "qrcode";
import { QR_ECC_LEVEL } from "./rollLabelPrn.js";

// Renders whatever QR content the caller built (see buildQrPayload in
// utils/rollLabelPrn.js -- "rollId vendorRollId paperSize paperMtrs") for the
// on-screen preview. Kept generic here: this file just encodes text as a QR,
// it doesn't know or care what the text means.
//
// Error correction level matches QR_ECC_LEVEL (the level the printer's own QR
// encoder uses for the .prn job -- see utils/rollLabelPrn.js) rather than
// picking independently, so the on-screen preview's QR is built to the same
// module count the physical print will be, not just a similar-looking one.
//
// Rendered as a raster PNG data URL, not SVG. The SVG path this used to take
// draws each row of modules as a single horizontal stroke at the default
// stroke-width (1 viewBox unit) -- correct in principle, but it only stays
// solid if the SVG scales perfectly uniformly, and that depended on getting
// its own width/height attributes and the container's CSS to agree exactly.
// Two different bugs came out of that (oversized in print, then squashed
// into a run of horizontal lines) before it was ever fully reliable. A raster
// image has none of that: a browser scales a bitmap to whatever box you give
// it, uniformly, the same way in every rendering context including print --
// there's no stroke geometry to distort. Generated at 600x600px so it stays
// sharp scaled down to the label's QR box even at high print DPI.
export async function rollLabelDataUrl(content) {
  return QRCode.toDataURL(String(content ?? ""), {
    errorCorrectionLevel: QR_ECC_LEVEL,
    margin: 1,
    width: 600,
  });
}

// Module count (the QR's own grid size, e.g. 21 for a version-1 code, 25 for
// version-2, etc.) for the same content/ECC level rollLabelDataUrl renders --
// lets the caller compute the physical box size (moduleCount x
// QR_CELL_WIDTH_DOTS), the same math the printer uses. Longer content (the
// full payload runs ~30-40 characters) can push this to a bigger QR version
// than a bare Roll ID alone would need, which is exactly why this has to be
// computed from the same content actually being encoded, not assumed fixed.
export function rollLabelModuleCount(content) {
  return QRCode.create(String(content ?? ""), { errorCorrectionLevel: QR_ECC_LEVEL }).modules.size;
}
