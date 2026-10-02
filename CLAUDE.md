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
node scripts/rebuild-die-signatures.js          # repair Die Master dup protection (see "Die duplicate signature")
node scripts/backfill-prodbinding-signatures.js
node scripts/backfill-prodbinding-calc.js
node scripts/sync-prodbinding-paper-fields.js    # re-sync ProdBinding paper code/family/vendor/rate from Paper Master (paperId)
node scripts/backfill-employee-nickname.js       # empNickName = first word of empName
node scripts/backfill-client-status-enhance.js   # Client/Username clientStatus FOLLOW UP -> ENHANCE
node scripts/backfill-paper-roll-ids.js          # PaperStock rollNo -> unique rollId
node scripts/backfill-paper-vendor-roll-id.js    # PaperStock vendorRollId <- rollId, where missing
node scripts/backfill-paper-invoice-no.js        # PaperStock invoiceNo <- "LEGACY", where missing
node scripts/backfill-paper-min-rate.js          # Paper minRate <- rate, where missing
node scripts/backfill-paper-max-rate.js          # Paper maxRate <- rate, where missing
node scripts/backfill-paper-stock-rate.js        # PaperStock/PaperStockLog rate <- Paper.rate, where missing
node scripts/backfill-label-order-rate-per-k.js  # legacy label order rates -> per 1000 (see "Label order rates")
node scripts/report-prodcalc-margin-source.js    # read-only: where prodcalc/view's Margin % comes from (see "Margin % source")
node scripts/send-back-to-pending.js <orderId>   # unassign one WIP order back to Pending (CLI form of the UI button)
node scripts/confirm-dispatched-pending-labels.js # confirm fully-dispatched label orders stuck at PENDING (dry-run; --apply to commit)
node scripts/fix-order-source-location.js        # repair stock orders saved with a client location (see "Sales order locations")
node scripts/repoint-orphaned-label-userid.js    # relink Label/ColorLabel bindings whose userId points at a deleted Username (dry-run; --apply to commit)
node scripts/report-labels-missing-vendor.js     # read-only: Label bindings with a blank or stuck Vendor Name
node scripts/report-duplicate-label-bindings.js  # read-only: exact-duplicate plain Label bindings on the same user (see "Duplicate plain Label bindings")
node scripts/fix-label-missing-mm-size.js        # Label bindings missing Width/Height (mm); always needs --id= + a human-confirmed size (see "Label Width (mm) / Height (mm)")
```

`backfill-paper-roll-ids.js` must be run **before** starting the app on code
that has the `rollId` unique index — see "Paper reel Roll IDs" below.

## Environment

Requires a `.env` file with at minimum:
- `SESSION_SECRET` — app crashes at startup without this
- `MONGO_URI` (or equivalent — see `config/db.js`)
- `TASKS_MONGO_URI` (optional) — the `/fairtech/tasks` feature stores its data in a separate, isolated database (`config/tasksDb.js`), for privacy. Without this set, it defaults to a sibling database named `<main db>_tasks` on the same server as `MONGO_URI`.
- `SACHIKO_VENDOR_NAME` (optional, default `SACHIKO PACKAGING`) and `SACHIKO_CLIENT_NAME` (optional, default `FAIRTECH SYSTEMS`) — the two ends of the Sachiko paper re-order export (see "Paper re-order export to Sachiko" below)
- In dev only: `PROPRIETOR_USER`, `PROPRIETOR_PASS`, `ADMIN_USER`, `ADMIN_PASS`, `HR_USER`, `HR_PASS`, `HOD_USER`, `HOD_PASS`, `COORDINATOR_USER`, `COORDINATOR_PASS`, `SALES_USER`, `SALES_PASS`, `PURCHASE_USER`, `PURCHASE_PASS`, `PRODUCTION_USER`, `PRODUCTION_PASS` (backdoor accounts; blocked in production)

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

Roles: `proprietor`, `admin`, `hod`, `coordinator`, `sales`, `hr`, `employee`, `master`, `operator`. `proprietor` sits above `admin` and is granted access everywhere `admin` is. Access guarded by `requireAuth` and `requireRole([...])` from `middleware/auth.js`.

`coordinator` is the full office sales role (formerly named `sales`); `sales` is now the restricted role for reps working in the field (formerly named `field_sales`) — see `hasSalesAccess`/`hasFieldSalesAccess` in `routes/fairdesk_route.js` and `isSales`/`isFieldSales` in `views/layout/boilerplate.ejs`, whose names still reflect the pre-rename roles even though the role *values* they check (`"coordinator"`/`"sales"`) have moved.

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

### Form style (Sales Order design)

`/fairtech/sales/order` and `/fairtech/sales/order/confirm` use a modern form
design (brand header band, flat underlined sections, 40px controls, sticky
action bar, `.so-dialog` dialogs) from `public/css/salesOrderForm.css`, scoped
under `.so-page`. **`formStyle.md`** (repo root) documents it — tokens,
markup skeleton, components, long-text/ellipsis rules, responsive behaviour,
the global common.css rules it has to override, and the steps to use it on
another page. Its dialog component also drives the master-data dialogs: New /
Edit Master Label (Labels list "+ Label"; label profile "Edit Label", plain
labels) and New / Edit Tape, POS Roll, Tafeta and TTR Master (each list's
"+ <item>" button; each profile's "Edit <item>"). Each form lives in one
partial (`views/inventory/labels/_labelMasterForm.ejs`,
`views/inventory/tape/_tapeMasterForm.ejs`,
`views/inventory/posRoll/_posRollMasterForm.ejs`,
`views/inventory/tafeta/_tafetaMasterForm.ejs`,
`views/inventory/ttr/_ttrMasterForm.ejs`) that the standalone create/edit pages
render too, and all of them share `public/js/soFormDialog.js` (`data-so-form`
forms, `soDialog.open/close`). The four item profiles share
`views/inventory/itemView.ejs`, which shows the Edit button and dialog only when
the route passes `editMaster`. Their `/<item>/edit/:id` routes serve both the
Change Status dialog (`status` alone, redirect) and the Edit dialog (spec
fields, JSON) — spec edits go through `updateMasterSpec` with a per-item spec
(`TAPE_MASTER_SPEC`, `POS_ROLL_MASTER_SPEC`, `TAFETA_MASTER_SPEC`,
`TTR_MASTER_SPEC`) that mirrors the create route's normalisation and duplicate
rules. Every page takes the stylesheet
from the `FORM_STYLE_CSS` constant at the top of `routes/fairdesk_route.js`
(list pages whose `CSS` slot holds `tableDisp.css` link it via the
`formStyleHref` local) — bump its `?v=` whenever the stylesheet changes.

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

### Sales order locations (stock vs client)

`/fairtech/sales/order` and `/fairtech/sales/order/confirm` show two fields that
both say "location" and mean completely different things. Mixing them is what
made confirmed orders undispatchable, so keep them apart:

| | Stock location | Client location |
|---|---|---|
| What | A warehouse in Location Master | The delivery place a client binding is tied to |
| Values | `UNIT 1`, `UNIT 2`, `OFFICE`, `PALGHAR`, `VAPI`, `AURANGABAD` | `WALUJ`, `BHIWANDI`, `DAMAN`, `JOGESHWARI`, … (towns/areas) |
| Read from | `Location.locationName`, via `GET /fairtech/api/locations` | `Username.userLocation` / `Username.locationDetails[].userLocation`, `<item>Binding.location` |
| On the form | the **stock bar** radios above Order Details (`#stock-display`, `name="locationRadio"`) → `#source-location` | the **Location** dropdown (`#user-location`, `name="userLocation"`) |
| Job | where stock is deducted from | scopes the item list (bindings are per client + location) |

For the stock-tracked types (`TAPE`, `POS_ROLL`, `TAFETA`, `TTR` —
`STOCK_BASED_ITEM_TYPES`, defined in both `routes/fairdesk_route.js` and
`salesOrderForm.ejs`), an order's `sourceLocation` **must** be a stock location:
dispatch deducts `<Item>Stock` at that exact string, the pending-booked
aggregation matches on it, and cancelling a confirmed order puts the stock back
there. A client location saved in that field is unrecoverable at dispatch time —
there is no stock anywhere by that name — and the symptom is misleading: the
confirm page locks dispatch to it, finds no stock-bar radio to lock onto, and so
disables **every** location, leaving a page where nothing is selected and
nothing can be picked; submitting then says "cannot dispatch, not enough
stocks".

Label / Color Label are **not** stock-tracked, and for them `sourceLocation`
legitimately holds the client's delivery location. That is why every guard is
keyed off the item type rather than applied flat. Their stock bar is hidden
outright (`isLabelItemType()` in `salesOrderForm.ejs`): with no stock behind it,
and locked to a delivery location no warehouse matches, it could only render a
row of disabled zeros with nothing ticked — which reads as a broken page.

**Both label kinds must always be tested together.** A Color Label order's
`onModel` is `"ColorLabel"`, so a bare `=== "Label"` check silently drops it into
the stock path — where it is looked up in `TapeStock` (the default ledger) under
its colour-label binding id, finds nothing, and refuses to dispatch with
"cannot dispatch, not enough stocks". Use `isLabelOrderModel(onModel)` in
`routes/fairdesk_route.js`, and `isLabelItemType()` / `isStockBasedItemType()` in
`salesOrderForm.ejs`, rather than comparing by hand. Both dispatch
(`status: CONFIRMED`) and the cancel-a-confirmed-order stock reversal used to
miss Color Label this way; the second wrote a `TapeStock` row referencing a
colour-label binding.

The rules, enforced in three places:

- **`salesOrderForm.ejs`** — `#source-location` is written from the stock bar
  only. `syncSourceLocationFromClientLocation()` is the one funnel for the
  client-location sources (the Location dropdown, and `item.location` from the
  items API), and it is a no-op for the stock-tracked types.
  `getSelectedStockLocation()` and the submit handler have no
  `locationSelect.value` fallback for those types either, so a missing pick
  fails loudly with "no location is selected" instead of quietly posting a
  delivery town.
- **`POST /sales/order`** — `userLocation` (and the `Username.userLocation`
  fallback) apply only to the non-stock types; for the rest the posted location
  is checked against `getStockLocationNames()` and rejected if it isn't one.
  There used to be a second fallback deriving the location from
  binding → user → `userLocation`; it is gone, since it could only ever produce
  a client location.
- **`POST /sales/order/status`** — re-checks against `getStockLocationNames()`
  before deducting, and writes the location it actually deducted from back onto
  the order, so a later cancel reverses the stock to where it really came from.

`scripts/fix-order-source-location.js` repairs orders already saved with a
client location (dry-run; `--apply` to commit). It fixes an order outright only
when exactly one stock location holds any of that item; anything ambiguous is
listed for a human, who names it with
`--order=<id> --location="UNIT 2" --apply`. Note the wrong location also
overstates that item's balance on the confirm page, because the order's booked
quantity lands in a bucket no location displays.

### Sales order rates

The Rate / Curr Rate fields on `/fairtech/sales/order` always take the client
binding's **gross** rate — the one the client is billed — never the
"Our Amount" figure beside it, which is that rate net of sales commission and
exists for margin work only:

| Item type | Binding field | Binding form label | Unit |
|---|---|---|---|
| Tape / POS Roll / Tafeta / TTR | `*RatePerRoll` | Rate Per Roll | per roll |
| Label / Color Label | `ratePerK` | Rate Per 1000 | **per 1000 labels** |

`ratePerLabel` (labels) and `tapeSaleCost` (tape) are both derived from the
net "Our Amount" side, so neither is an order rate. The Production
Calculator's margin maths does still read `ratePerLabel` — that one wants the
net figure.

Label and Color Label orders are the odd ones out: `quantity` is in labels but
`orderRate` is per 1000, so **order value = quantity × orderRate ÷ 1000**.
Each order records which scale it is on in `orderRateUnit` (`"PER_K"`), and
every value calc keys the divisor off that field rather than off the item
type — because orders placed before this switch stored the net *per-label*
rate and carry no `orderRateUnit` at all, and a missing unit means per-label
(divisor 1), which keeps their totals correct. The order schemas give the
field no default on purpose: a default would make Mongoose hydrate those
legacy orders as `PER_K` and restate their rate 1000×.

The calcs that apply the divisor: `remainingOrderValuePipeline()` and
`orderLineValue()` in `routes/fairdesk_route.js`, plus client-side copies in
`pendingLabelOrders.ejs`, `pendingColorLabelOrders.ejs` and
`users/clientOrders.ejs`. `salesOrderForm.ejs`'s `orderRateOnCurrentScale()`
does the matching thing when prefilling Curr Rate for an edit, so re-saving a
legacy order can't stamp `PER_K` onto a per-label number.

Run `scripts/backfill-label-order-rate-per-k.js` (dry-run; `--apply` to
commit) to put existing label orders on the per-1000 scale. It is optional —
legacy orders read correctly either way — and idempotent, since it only
touches orders with no `orderRateUnit`.

### Margin % colour bands (shared)

The row shading for Margin % is defined **once**, in `views/layout/boilerplate.ejs`:
`window.MARGIN_BANDS` (the thresholds), `window.MARGIN_BAND_CLASSES` (every
class a rowFormatter must clear before re-applying), `window.marginBandClass(v)`
(value → class), and the `.row-margin-*` CSS. Bands are **upper-inclusive**:
`<= 1.3` red, `> 1.3–1.4` yellow, `> 1.4–1.5` green, `> 1.5` white. A blank or
non-numeric value returns `""` and leaves the row unshaded — the helper uses
`parseFloat`, not `Number`, precisely so `Number("") === 0` can't paint an
unknown margin red.

Consumers: `views/utilities/prodCalcView.ejs` (on `prodActual`) and
`views/inventory/orders/pendingLabelOrders.ejs` (on `marginPct`). Both are
one-liners delegating to the helper. **Never redefine the thresholds or the
classes in a view** — that is exactly how the two pages fell out of step
before. Change a band in the layout and every page follows.

It lives in the layout `<head>` as a plain inline `<script>`, deliberately not
in `common.js`: `common.js` is loaded with `defer`, so it runs *after* the
views' inline `<script>` blocks, and both pages construct their Tabulator (and
run its `rowFormatter`) inline at parse time. A deferred helper would still be
undefined at that point.

### Margin % source (Production Binding view)

The Margin % column on `/fairtech/prodcalc/view` (`prodActual`, and its
625-basis sibling `prodActual625`) is driven by **Our Amount Per 1000** — the
label rate *net* of sales commission — never the gross `ratePerK` the client is
billed. `Label.ratePerLabel` is `(ratePerK - commissionPerK) / 1000`, i.e. Our
Amount Per 1000 ÷ 1000 (`views/inventory/labels/labels.ejs`,
`models/inventory/labels.js`). This is the one place the *net* side is the
right input — contrast "Sales order rates" above, where order rates always
take the gross figure.

Neither the margin nor the rate is read from the snapshot saved with the
binding. `routes/fairdesk_route.js` recomputes both on every page load:
`withLiveRate()` swaps in the Paper Master's current rate via `paperId`, then
`withLiveLabelRate()` re-reads the Label's current `ratePerLabel` via
`labelProductId` and redoes the maths —

```
productionRate = ratePerLabel / prodArea
sqMtrsRate     = productionRate * 1550
Margin %       = sqMtrsRate / paperRate        -> prodActual
```

— so editing a label's commission moves Margin % here without reopening and
resaving every binding built from it. Call `withLiveRate` **first**; the label
recompute needs the live paper rate.

A row falls back to its stored snapshot when the recompute can't run:
`withLiveLabelRate` skips the binding outright if `labelProductId` doesn't
resolve to a Label with a numeric `ratePerLabel`, and its inner `recompute()`
returns `{}` unless `prodArea` is non-zero, omitting `prodActual` alone unless
the paper rate is non-zero too. So a binding with a perfectly good label can
still be frozen for want of an area or a rate.

**Outsourced bindings have no Margin % at all, by design** — an outsourced
label is bought in finished, so it saves with no paper details, hence no
`prodArea` and no paper rate (see "Outsourced labels" above). They fail the
same two tests as a genuinely broken binding, so anything auditing this must
check `isOutsource` **first** and exclude them; telling someone to resave one
to "fix" its missing paper rate is wrong advice.

`scripts/report-prodcalc-margin-source.js` reports exactly this — read-only, no
`--apply`. It classifies every binding live / frozen (with the reason) /
outsourced, verifies every Label still satisfies `ratePerLabel == (ratePerK -
commissionPerK)/1000`, and lists how far each stored snapshot has drifted from
its live recompute (harmless — the page shows the live figure). Flags:
`--frozen` for the frozen rows only, `--tolerance=N` for the drift threshold,
`--csv=out.csv` for the full per-binding dump. The tolerance defaults to
`0.001`: snapshots store to 5dp and dividing by `prodArea` amplifies that in
proportion to the margin, so a ~12% row drifts ~1e-4 on rounding alone. Note
when reading its code that these fields are stored as strings, so blank must be
tested as `NaN` and not `Number("") === 0`.

### Outsourced labels

An outsourced label is bought in as finished labels from a vendor rather than
printed in-house. That is a decision about how the job is *made*, so the flag
lives on the **Production Binding** — `isOutsource` in
`models/utilities/productionBinding.js`, set by the **Out Source** checkbox
beside Vendor Name on `/fairtech/form/prodcalc`. It is deliberately **not** on
the client Label binding (`/fairtech/form/labels`), which stays purely about
the client's side of the deal.

Ticking the box takes the whole paper side of the form away with it: **Vendor
Name** (that select is the *paper* vendor, SL (PAPER) scoped — the outsourcing
vendor is bound separately through `VendorOutSourceBinding`, Purchase →
Outsourced Orders), **Family**, **Paper Code**, **Paper size** and the resolved
rate/`paperId` are all cleared, disabled and no longer `required`. The
**Calculated Values** table is hidden outright — every figure in it (production
area, sq inch rate, per-label prod cost, margin) derives from the paper size and
rate, so none of it can mean anything for a job bought in finished.

`POST /form/prodcalc` blanks those same fields server-side. A disabled control
isn't posted at all, so `findByIdAndUpdate` would otherwise leave an in-house
binding's old paper details on record when it's switched to outsourced.

**Die and Block are deliberately left usable** — the die may be FAIRTECH's own,
sent out to the vendor, so an outsourced binding can still record which tooling
the job runs on. Neither has ever been `required`; the only required fields on
this form are Client, User, Location, Label and (in-house only) Paper Code +
Paper size.

An outsourced binding shows an `OUTSOURCE` pill in place of its (empty) Vendor
on `/fairtech/prodcalc/view` and on the binding detail page. On the list it's
backed by a computed `vendorDisplay` field rather than done purely in the
Tabulator formatter, so the header filter matches it and the PDF/Excel
downloads — which export raw field values, not rendered cells — carry it too.

Downstream, `utils/pendingProduction.js` is the single reader:

- `isOutsourcedLabel(labelId)` — true when *any* ProductionBinding for that
  label is outsourced (a label can have several, one per die/block). Keyed on
  `labelProductId` alone, compared as a **string**: ProductionBinding is a
  `strict: false` schema, so it stores the raw form value rather than a cast
  ObjectId. The Label binding is already specific to one client + user +
  location, so the label id identifies the whole context.
- `upsertPendingProduction()` skips outsourced labels — their orders never get
  a PendingProduction row, since there's no machine/operator queue to join.
- `resyncPendingProductionForLabel()` runs after every prodcalc save and moves
  orders already PENDING when the flag flipped. It leaves rows that are past
  Assign Production (`assignedMachineId` set) alone — that job is on a machine
  with a lot no. against it, and a binding edit shouldn't pull it out from
  under the shopfloor.

`getOutsourcedOrders()` in `routes/inventory/reorder.js` lists the PENDING
label sales orders for those labels on `/fairtech/inventory/outsourced-orders`.
It reads the sales orders directly, not PendingProduction — which is exactly
why the resync above matters: without it an order could show on both pages.

From there, `/fairtech/form/vendor-item-binding/outsource?itemId=<labelMasterId>`
binds the outsourcing vendor. Two things about that form:

- Its vendor list is scoped to Vendor Master entries carrying the
  **`OUTSOURCE`** commodity. If none do, it says so and links to Vendor Master
  rather than leaving an unexplained empty dropdown.
- It renders the label master's spec read-only when `?itemId=` names one, and
  hides the "Label Specifications" cascading selects in that case — those exist
  to *find* a master (the side-nav entry passes no `itemId`), so with one
  already fixed by the URL they'd only duplicate it.

### Paper re-order export to Sachiko

`/fairtech/inventory/paper-reorder` has an **Export to Sachiko** button that
writes a JSON file the Sachiko app imports on its own Pending Orders page
(`/sachiko/sales/pending` → **Import**), turning FAIRTECH's paper shortfall
straight into a sales order there. The two apps are separate deployments on
separate databases with nothing joining them, so the file is the whole
interface — there is no API call, no shared collection.

What holds it together is a pair of strings the two masters already agree on:

| FAIRTECH | Sachiko |
|---|---|
| `Paper.prodCode` (`C001WB`, `P002WB`, …) | `SachikoLabelStock.productCode` |
| `Paper.vendorName` = `SACHIKO_VENDOR_NAME` | — (identifies which rows are Sachiko's to sell) |
| `SACHIKO_CLIENT_NAME` | `Username.clientName` — FAIRTECH as a *client* over there |

Both names are env-overridable (see Environment above) because a rename on
either side silently empties the export otherwise.

Only rows that are **actually short** are exported: that vendor's paper specs
whose `balanceMtrs` is below zero. The quantity ordered is the **shortfall**,
not the whole requirement — Balance Mtrs already has stock on hand and
WIP-reserved reels taken out of it, so the gap is what has to be bought. Rolls
are `ceil(shortfall / 1000)`, the same flat `STANDARD_ROLL_METERS` a roll is
counted as everywhere else on that page, and `runningMeters` on each line is
that same 1000 (what Sachiko's order lines call RM).

`buildPaperReorder()` in `routes/inventory/paperReorder.js` computes the page's
groups; both `GET /paper-reorder` and the two export routes call it, so the
file can never disagree with the table it was generated from. The export
**recomputes from the database** rather than trusting what the browser holds —
the page may have been open for hours and these quantities become a real
purchase order at the other end.

Routes:
- `GET /paper-reorder/export/preview` — what the dialog shows before anything
  is generated: the lines that would go in the file, plus the PO number it
  would carry. Previews the sequence **without consuming it**.
- `POST /paper-reorder/export` — builds and returns the file as a download.

PO numbers run on their own per-financial-year sequence (Counter key
`paperReorderPo:<YY-YY>`, format `PR/<YY-YY>/NNN` — "PR" for Paper Re-Order,
reset each year like the paper reel ids). The dialog pre-fills the field with
the previewed number and sends an **empty** `poNumber` when the user leaves it
alone; that empty value is the only case that actually claims a sequence
number. A PO number typed in by hand is the purchase team's own and is taken
verbatim without touching the counter.

### Paper reel Roll IDs

Every `PaperStock` row is one physical reel, identified by `rollId` — a unique,
system-generated `ITEMCODE/YY-YY/NNN` (e.g. `C011/26-27/048`) from
`utils/rollId.js`. `ITEMCODE` is the reel's own paper's Prod Code (uppercased),
`YY-YY` is the financial year (April–March) at inward, and `NNN` is a sequence
number scoped per item code *and* year (Counter key
`paperRollId:<ITEMCODE>:<YY-YY>`, so it resets each financial year and each
paper starts its own count). It replaced the free-text vendor "Roll No", which
repeated across reels and so could not name one reel for deduction.

The flow it exists for:

1. **Inward** (`/fairtech/paperstock`) — one invoice, one submit: the shared
   top of the form (date, vendor, invoice no, stock location) is filled once.
   Below that, "Paper Details" is a repeatable block (`+`/`−` buttons, JS-only,
   always adds/removes from the end so a block's index never shifts while
   present) — each block has its own Family/Prod Code/Rate/Paper ID/Paper Size,
   letting one invoice bring in several distinct papers, not just several
   rolls of the same one. Within a block, "No of Rolls" opens that many row
   groups (Roll ID, Vendor Roll ID, Mtrs) — one per physical reel of that
   paper. `family`/`prodCode`/`rate`/`paperSize`/`paperId` are posted as
   repeated same-name fields (one entry per block, in DOM order); each roll
   row also carries a hidden `rollBlockIndex` saying which block it belongs to
   — `routes/stock/paperStock.js`'s `POST /create` groups rolls by that index
   before resolving/creating each block's Paper and looping its rolls, so
   roll-id sequencing and running-stock totals stay correct per paper even
   when several are submitted together. `rollId` is generated per row on save,
   never typed; the form previews the next N ids as a batch (read-only,
   `GET /fairtech/paperstock/preview-roll-ids?prodCode=&count=`) whenever a
   block's Prod Code or row count changes, so row 1 always shows the lowest id
   and they read as a consecutive run. Saving creates every reel across every
   block in one request and redirects to
   `/fairtech/paperstock/batch?ids=<comma-separated stockIds>` —
   a summary listing every roll just created, each with its own Label/`.prn`
   link (`GET /fairtech/paperstock/label/:stockId[/prn]`).
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
on the roll — typed per-row at inward, kept purely as a cross-reference against
the vendor's paperwork. It plays no part in the QR/scan/deduction flow above and
carries no unique constraint (vendor numbers repeat, which is exactly why they
can't identify a reel). Unlike `rollId`, it's editable at any time — including
on a booked reel — since correcting it doesn't touch anything the system
matches on.

`PaperStock.invoiceNo` is the vendor's invoice the reel arrived on, typed once
at the top of the batch inward form and copied onto every reel created from
that submission — also required, also not unique (one invoice legitimately
covers many reels). Existing reels from before this field existed carry the
placeholder `"LEGACY"` (`scripts/backfill-paper-invoice-no.js`) so they can
still be saved through the reel-edit form, which validates the whole document
on save even though it doesn't itself expose an Invoice No field to edit.

`PaperStock.rate` is what that specific reel was actually bought at, set once
at inward from the Paper Details block's Rate field and never changed
afterwards — a reel inwarded today at ₹20 stays distinct from one inwarded
tomorrow at ₹25 even though both are the same paper. This is separate from
`Paper.rate` (the master's current rate) and `Paper.previousRate`/`minRate`,
which only track the paper's rate history in aggregate (see "Paper Master
rate tracking" below) and can't tell one reel's price from another's.
Existing reels from before this field existed are backfilled from the paper
master's rate at the time (`scripts/backfill-paper-stock-rate.js`), the
closest available stand-in since the original inward rate wasn't recorded.

### Paper Master rate tracking

`Paper` carries four rate fields, all in `models/inventory/paper.js`: `rate`
(the last/current rate), `previousRate` (whatever `rate` held just before its
last change), `minRate` (the lowest `rate` has ever been for this paper), and
`maxRate` (the highest). All four show as their own columns on
`/fairtech/paper/view` — "Last Rate", "Previous Rate", "Lowest", "Highest".

Paper Stock inward (`POST /fairtech/paperstock/create`,
`bumpPaperRate()` in `routes/stock/paperStock.js`) only ever moves the master
rate **up**: a paper's entered rate updates `rate`/`previousRate`/`minRate`/
`maxRate` only when it's strictly higher than the paper's current rate. An
equal or lower entered rate is a vendor's cheaper quote for that reel — not a
master price correction — and is ignored entirely; nothing on the master
changes. (The reel's own price is still recorded regardless, in
`PaperStock.rate` above — it's only the master's aggregate rate history that's
gated this way.)

A manual edit from the Paper Master edit dialog (`PUT /fairtech/paper/:id`) is
different: it's a deliberate correction, so it shifts
`previousRate`/`minRate`/`maxRate` in either direction (including down)
whenever the rate field changes.

New papers seed `minRate`/`maxRate` with their starting `rate` (no history
yet, so the only rate on record is both the lowest and the highest). Existing
papers from before these fields existed are backfilled the same way
(`scripts/backfill-paper-min-rate.js`, `scripts/backfill-paper-max-rate.js`).

### Die duplicate signature

`/fairtech/form/die` blocks a die being re-entered as a new Die No if another
die already has the same spec. `buildDieSignature()` in
`routes/fairdesk_route.js` hashes the physical identity — type, make, blade
type, machine no(s), family, dimensions, etc — **and `dieFlatRemark`**, the
free-text remark field. The remark is part of the identity, not metadata:
two dies can otherwise match on every dimension field yet be different tools
(e.g. a mirrored or gap-variant flat noted only in the remark), so without it
they'd wrongly collide as duplicates. It deliberately excludes the generated
`dieDieNo`/`dieVersion` (see the comment above `buildDieSignature`), and it is
**not** a unique DB index — a "Replace"/"New Version" record is expected to
share its predecessor's signature, so uniqueness is enforced in the route,
which excludes the die's own lineage (`lineageDieIds`) before comparing.

`dieSignature` is recomputed and stored on every create/edit. Run
`scripts/rebuild-die-signatures.js` (dry-run; `--apply` to commit) after
changing what `buildDieSignature()` hashes — e.g. adding `dieFlatRemark` —
so existing dies' stored signatures reflect the new formula instead of a
stale one the duplicate check silently ignores.

### Duplicate plain Label bindings

`POST /form/labels` refuses to create a second plain Label binding for the
same user if one already exists with the same `labelMasterId` + `labelUps` +
`labelCore` + `labelFamily` + `location` (see the comment above the
`Label.exists({...})` check in `routes/fairdesk_route.js`). That guard is
scoped to the route itself, not to the database — anything that pushes an id
onto `Username.label` without going through it can still produce an exact
duplicate pair, and nothing downstream (not the schema, not an index) catches
it afterwards.

The bypass that created the existing ones: `scripts/repoint-orphaned-label-userid.js`
relinks a binding whose `userId` points at a deleted Username back onto
today's matching account via `$addToSet` on that account's `label`/`colorLabel`
array. `$addToSet` only blocks adding the exact same `_id` twice — if that
account already had a fresh binding with the identical spec (typically
because the client's record was recreated and the label got bound again
under the new `_id` before the old one was repointed), the old binding got
reattached right alongside it with no spec check at all. The result was two
Label documents on one Username that were otherwise identical, one from the
original bind date and one from whenever the account was re-bound.

That script now checks each target's current array for a binding with the
same identity (the Label guard's five fields, or ColorLabel's masterId+location)
before reattaching, and skips with a "needs a decision" line instead of
reattaching when one already matches — so this exact bypass can't recur. It
only guards its own write, though; it does nothing for the pairs that already
exist from before the fix (see the report script below for those).

`scripts/report-duplicate-label-bindings.js` lists exactly these pairs
(read-only — it does not delete or merge anything, since either `_id` may
already be referenced by an order or a `ProductionBinding`, so which one to
keep is a human decision). It's the same identity key as the create-time
guard above, so it can't disagree with what the guard would have blocked.

### Stale clientName snapshot can hide a valid label on /form/prodcalc

`Label`/`ColorLabel`/`PendingProduction` items all carry a denormalized
`clientName` string, snapshotted once when the binding was created.
`Username.clientName` is the live value, and the two **drift apart** the
moment someone edits a client's canonical name afterwards — e.g. adding a
disambiguating suffix like `" ( UNIT-1 )"` once a second site for that
client opens. The snapshot never gets touched by that edit.

`/fairtech/form/prodcalc?fromLabel=<id>` (the "Bind" button on
`/fairtech/labels/production-binding/pending`) and `?fromPending=<id>` both
used to prefill the Client field from that stale snapshot. The Client
`<select>` on the form is built from the *live* name list
(`Client.distinct("clientName")`), so the stale snapshot matches nothing
there, `loadClientData()`'s user lookup 404s, and the label — still active,
still genuinely bound, visible on `/fairtech/labels/view/:userId` — renders
as `"? x ? (label removed)"` on the Production Binding form. Nothing was
deleted; the name just stopped matching.

Two fixes, both in `routes/fairdesk_route.js`:
- `buildProdcalcPrefill()` now resolves the client name from the *live*
  `Username` doc via `userId` (a real reference) first, falling back to the
  passed-in snapshot only if that user no longer exists.
- `GET /form/prodcalc/client-labels/:clientName` (what populates the Label
  dropdown's candidate list) no longer trusts `Label.clientName`/
  `ColorLabel.clientName` alone — it unions in every label/color-label
  reachable through the *live* `Username.label`/`colorLabel` arrays for any
  Username matching that client name, so a stale per-binding snapshot can no
  longer make an otherwise-valid binding invisible to this endpoint.

Found via `UDYOGI SAFETY APPLIANCES PVT.LTD` (snapshot) vs.
`UDYOGI SAFETY APPLIANCES PVT.LTD ( UNIT-1 )` (live) and
`FLAIR WRITING EQUIPMENTS PVT LTD -FWEPL VALSAD` (snapshot) vs.
`FLAIR WRITING EQUIPMENTS PVT LTD -FWEPL-1 ( VALSAD )` (live) — both still
have the old, now-cosmetic-only mismatch sitting in their stored
`clientName` field; nothing currently depends on correcting it, since the
lookup no longer needs it to match.

### Label Width (mm) / Height (mm)

`Label.labelWidth`/`labelHeight` are the size the client-facing spec dropdown
offers (`/form/labels`, `/labels-binding/edit/:id`) — a free-text value that
can be a plain number ("102") or given in inches ("4\""). Dies, on
`/form/prodcalc`, are always matched in mm. Two separate things can make the
label's own width/height the wrong number to match a die against:

- it's in inches, which isn't even the same unit;
- it's a plain number, but a *rounded* one — the customer asked for a
  102×102mm label, the nearest matching Label Master is 100×100, and the
  label binding only ever recorded the matched 100×100.

`Label.labelWidthMm`/`labelHeightMm` is the fix for both: a manually-typed
real-world mm size, **always visible** as its own pair of fields on both the
create (`labels.ejs`) and edit (`labelsBindingEdit.ejs`) forms (no automatic
conversion — these used to be hidden unless the main Width/Height carried a
`"`, which missed the "rounded plain number" case entirely). `prodCalc.ejs`'s
`dieWidth`/`dieHeight` — what actually drives `loadDieOptions`/
`loadBlockOptions` — use `labelWidthMm`/`labelHeightMm` whenever either is
set, regardless of how the label's own width/height is expressed, falling
back to the raw values only when no mm override was given.

There is **no reliable formula** to derive one from the other. Most existing
records happen to follow inches × 25 (`4" → 100`, `6" → 150`), but it is not a
rule — at least one real binding has `6" → 100`, not 150, because that's the
die actually on hand. Never auto-fill this field from a conversion; it has to
come from the die or the customer.

`scripts/fix-label-missing-mm-size.js` finds Label bindings whose Width or
Height is in inches but have no mm recorded (read-only by default). Because
there's no safe default, it never bulk-applies — every binding it finds needs
`--id=<id> --widthMm=<mm> --heightMm=<mm> --apply` with a human-confirmed
size, the same "needs a decision" shape as `fix-order-source-location.js`.
