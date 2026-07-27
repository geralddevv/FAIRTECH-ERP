# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm start          # Run the server (node server.js) on port 3000
```

No test suite exists. There is no build step — this is a plain Node.js ES-module project.

Utility scripts (run directly). The signature/backfill ones are dry-run by
default — pass `--apply` to commit:
```bash
node scripts/rebuild-paper-signatures.js        # repair Paper Master dup protection
node scripts/backfill-prodbinding-signatures.js
node scripts/backfill-prodbinding-calc.js
node scripts/backfill-employee-nickname.js       # empNickName = first word of empName
node scripts/backfill-paper-roll-ids.js          # PaperStock rollNo -> unique rollId
node scripts/backfill-paper-vendor-roll-id.js    # PaperStock vendorRollId <- rollId, where missing
```

`backfill-paper-roll-ids.js` must be run **before** starting the app on code
that has the `rollId` unique index — see "Paper reel Roll IDs" below.

## Environment

Requires a `.env` file with at minimum:
- `SESSION_SECRET` — app crashes at startup without this
- `MONGO_URI` (or equivalent — see `config/db.js`)
- `TASKS_MONGO_URI` (optional) — the `/fairtech/tasks` feature stores its data in a separate, isolated database (`config/tasksDb.js`), for privacy. Without this set, it defaults to a sibling database named `<main db>_tasks` on the same server as `MONGO_URI`.
- In dev only: `PROPRIETOR_USER`, `PROPRIETOR_PASS`, `ADMIN_USER`, `ADMIN_PASS`, `HR_USER`, `HR_PASS`, `HOD_USER`, `HOD_PASS`, `SALES_USER`, `SALES_PASS` (backdoor accounts; blocked in production)

## Architecture

### Route structure

All app routes live under `/fairtech/`. Routes are split into sub-router files and mounted in `server.js`:

| Mount point | File |
|---|---|
| `/fairtech/*` (main views) | `routes/fairdesk_route.js` |
| `/fairtech/` (machine master + binding) | `routes/system/machine.js` |
| `/fairtech/payroll` | `routes/acccounting/payroll.js` |
| `/fairtech/loan` | `routes/acccounting/loan.js` |
| `/fairtech/advance` | `routes/acccounting/advance.js` |
| `/fairtech/employee` | `routes/hr/employee.js` |
| `/fairtech/client` | `routes/users/clients.js` |
| `/fairtech/` (tape/pos/tafeta/ttr bindings) | `routes/inventory/*.js` |
| `/fairtech/tapestock` etc. | `routes/stock/*.js` |

Roles: `proprietor`, `admin`, `hod`, `sales`, `hr`, `employee`, `master`, `operator`. `proprietor` sits above `admin` and is granted access everywhere `admin` is. Access guarded by `requireAuth` and `requireRole([...])` from `middleware/auth.js`.

`operator` is a session-only role: shopfloor operators sign in at `/fairtech/operator/login` with nick name (`empNickName`) + location + password (their employee record has `empProfile: "OPERATOR"` and `role: "none"`), and land on the queue of the machine named by their profile code. They can reach only `routes/system/machine.js` — mounted ahead of the other `/fairtech` routers, since each of those runs `requireRole` for every `/fairtech/*` request, not just its own paths.

### View rendering pattern

Every route renders an EJS view using the `boilerplate.ejs` layout:

```js
res.render("inventory/machineMaster.ejs", {
  JS: false,            // or "filename.js" — loaded as /js/<filename>
  CSS: "tableDisp.css", // or false — loaded as /css/<filename>
  title: "Machine Master",
  // ... data for the template
  notification: req.flash("notification"),
});
```

Views start with `<% layout('/layout/boilerplate') %>`. The layout loads `common.css`, `choices.min.css`, Bootstrap, Font Awesome, and `common.js` on every page. The `.indi-head` header bar class is in `tableDisp.css` — pass `CSS: "tableDisp.css"` in the route render call when using it.

### CSRF

`common.js` wraps `window.fetch` globally to auto-inject `x-csrf-token` on every request. For HTML forms, either include `<input type="hidden" name="_csrf" value="<%= csrfToken %>">` or rely on the form submit interceptor in `common.js` (which also injects `_csrf` on POST forms).

### Rate limiting

All mutating routes must use limiters from `utils/limiters.js`:

```js
import { createLimiter, updateLimiter, deleteLimiter } from "../../utils/limiters.js";

router.post("/...", requireAuth, createLimiter, async (req, res) => { ... });
router.put("/...",  requireAuth, updateLimiter, async (req, res) => { ... });
router.delete("/...", requireAuth, deleteLimiter, async (req, res) => { ... });
```

### Photo / video uploads (shared media store)

`utils/media.js` is the one way to take a photo or video from a user. It
compresses on the way in (images → EXIF-rotated JPEG capped at 1600px; videos →
faststart H.264 MP4 capped at 1280px, trimmed to 2 min, via the bundled
`ffmpeg-static` binary), writes a 400px JPEG thumbnail for both, and returns
records matching `mediaAssetSchema` (`models/system/mediaAsset.js`) to embed on
your document. Files live in `media/<bucket>/` — one bucket per feature —
under a random filename; `media/` is gitignored.

```js
const upload = mediaUpload({ bucket: "maintenance", fields: [
  { name: "photo", kind: "image", maxCount: 1 },
  { name: "video", kind: "video", maxCount: 1 },
]});

router.post("/x", requireAuth, createLimiter, upload, async (req, res) => {
  const assets = await storeUploads(req.files, "maintenance"); // compresses + cleans temps
  try { await Thing.create({ media: assets }); }
  catch (e) { await removeAssets(assets); throw e; }          // no orphan files
});
```

Serve files back with `sendAsset(res, asset, { thumb })` after your own auth
check — it honours Range requests, which is what lets a video seek and start
playing immediately. Route them by document id + array index (see
`routes/system/maintenance.js`), never by filename.

Note the CSP in `server.js` allows `media-src 'self' blob:` — blob for previewing
a picked clip before upload. Image previews must use a `data:` URL (`img-src`
does not allow blob).

### Embedding server data in views

Use the `safeJson` helper (available as `res.locals.safeJson`) to safely embed JSON in templates:

```html
<script id="locations-data" type="application/json"><%- safeJson(locations) %></script>
```

Then in client JS:
```js
const locations = JSON.parse(document.getElementById("locations-data").textContent);
```

Never interpolate object data directly into `<script>` blocks or `onclick` attributes.

### Dialog / modal pattern

Use the `.logout-modal` / `.logout-dialog` CSS classes from `boilerplate.ejs` for all dialogs. Key rules:
- Dialog `<dialog>` element: `style="width: min(440px, 95vw); padding: 0; border-radius: 14px; border: none;"` — **no `overflow: hidden`**
- Apply `border-radius: 14px 14px 0 0` to `.dialog-header` and `border-radius: 0 0 14px 14px` to `.dialog-body` instead — avoids clipping Choices.js absolutely-positioned dropdowns

### Choices.js

Choices.js v11.1.0 is available globally (loaded via CDN in boilerplate). In dialogs, use the destroy/reinit pattern:

```js
let myChoices = null;
function openDialog() {
  if (myChoices) { myChoices.destroy(); myChoices = null; }
  const sel = document.getElementById("my-select");
  sel.innerHTML = options.map(o => `<option value="${o._id}">${o.name}</option>`).join("");
  myChoices = new Choices(sel, { searchEnabled: true, shouldSort: false, itemSelectText: "" });
}
```

To pre-select a value on edit, set the `selected` attribute in the `<option>` HTML before calling `new Choices(...)` — more reliable than `setChoiceByValue` after init.

Add `z-index: 99999` to `.choices__list--dropdown` inside dialogs so the dropdown list renders above the dialog overlay.

### Passing data to onclick handlers

Use `data-*` attributes on buttons; read them in the handler via `this.dataset`. Never interpolate strings into onclick attributes (escaping is fragile):

```html
<button data-id="<%= item._id %>" data-name="<%= item.name %>"
        onclick="openEditDialog(this.dataset.id, this.dataset.name)">Edit</button>
```

### Text inputs auto-uppercase

`common.js` automatically converts all `input[type="text"]` values to uppercase on input. This matches the Mongoose model convention of storing names in uppercase.

### Paper reel Roll IDs

Every `PaperStock` row is one physical reel, identified by `rollId` — a unique,
system-generated `ITEMCODE/YY-YY/NNN` (e.g. `C011/26-27/048`) from
`utils/rollId.js`. `YY-YY` is the financial year (April–March) at inward, and
`NNN` is a sequence number that resets each financial year (Counter key
`paperRollId:C011:<YY-YY>`). `ITEMCODE` is currently **hardcoded to `"C011"`
for every reel** — deriving it per-paper from Prod Code isn't wired up yet
(see the `TODO` in `utils/rollId.js`). It replaced the free-text vendor
"Roll No", which repeated across reels and so could not name one reel for
deduction.

The flow it exists for:

1. **Inward** (`/fairtech/paperstock`) — `rollId` is generated on save, never
   typed; the form previews the next one (read-only,
   `GET /fairtech/paperstock/preview-roll-id`) on page load. Saving redirects
   to `/fairtech/paperstock/label/:stockId`.
2. **Print job** — `utils/rollLabelPrn.js` builds the actual print file: raw
   TSPL commands as a downloadable `.prn` (`GET
   /fairtech/paperstock/label/:stockId/prn`), for FAIRTECH's pre-printed label
   stock (101.5 × 75.1 mm) and thermal printer. Only two things are drawn —
   everything else on the label (captions, grid lines) is already on the
   blank stock: a `TEXT` line carrying just the Roll ID, and a `QRCODE` line
   whose payload is `"rollId vendorRollId paperSize paperMtrs"`
   (`buildQrPayload`) — matching FAIRTECH's original label design. Both sit at
   fixed dot coordinates (`TEXT_X_DOTS`/`QR_X_DOTS` etc.) in the label's
   bottom-right corner, rotated 180° to match the print head's feed direction.
3. **On-screen preview** — `views/stock/paperRollLabel.ejs` mirrors the same
   region of the label, to scale (dots → mm via `DOTS_PER_MM`), so it's not
   just "a label with the right things on it" but the actual print at the
   actual coordinates. The QR is rendered as a raster PNG (`rollLabelDataUrl`
   in `utils/rollLabel.js`, via `qrcode`'s `toDataURL`) rather than SVG — an
   SVG-based QR here went through two rendering bugs (oversized in print,
   then squashed into a run of horizontal lines) from the SVG's own
   width/height and the container's CSS needing to agree exactly; a raster
   image just scales as a bitmap, uniformly, everywhere. Text and QR are
   **not** rotated to match the print's rotation=180 in the preview — that
   value is about the print head's feed direction, not how the label reads to
   a person, and a screen has no feed direction to compensate for.
4. **Job card** (`/fairtech/machine/jobcard/form`) — the operator scans that QR
   into a Job Setting / Production Log **Roll ID** box, which fills with the
   *whole* payload string, not just the id. A wedge scanner's trailing Enter
   is swallowed (it would submit the form); the handler also extracts just
   the Roll ID (the first token) and swaps the box's value down to that clean
   id before moving focus to Mtrs. The scan is checked against the job's
   allotted reels client-side.
5. **Deduction** — `consumeAllottedRollMeters` in `routes/system/machine.js`
   matches the scanned id to `PendingProduction.allottedRollIds →
   PaperStock.rollId`, subtracts `stop − start` metres, empties the reel
   (`paperMtrs: 0, quantity: 0`) when it hits zero, and writes an **OUTWARD**
   `PaperStockLog` line per reel (`quantity` is rolls, so 1 only when emptied;
   metres go in `paperMtrs`).

Compare ids with `normalizeRollId()` (trim, strip whitespace, uppercase), or
`extractScannedRollId()` when the input might be the QR's full
"rollId vendorRollId paperSize paperMtrs" payload rather than a bare id (job
card matching always uses this one) — both in `utils/rollId.js`; the client
copy in `jobCardForm.ejs` must stay in step.

`rollId` is **not editable**: it is printed on a physical label, so a reel that
is wrong gets deleted and inwarded again. The reel edit/delete forms post the
PaperStock `_id` as `reelId` to keep it distinct from `rollId`.

Separately, `PaperStock.vendorRollId` is whatever the vendor themselves wrote
on the roll — typed by the operator at inward (required, right after the
auto-filled Roll ID field), kept purely as a cross-reference against the
vendor's paperwork. It plays no part in the QR/scan/deduction flow above and
carries no unique constraint (vendor numbers repeat, which is exactly why they
can't identify a reel). Unlike `rollId`, it's editable at any time — including
on a booked reel — since correcting it doesn't touch anything the system
matches on.
