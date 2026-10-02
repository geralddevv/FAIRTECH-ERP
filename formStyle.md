# Form Style — the Sales Order design language

The look first built for **Sales Order** (`/fairtech/sales/order`) and
**Dispatch Order** (`/fairtech/sales/order/confirm`): one sheet with a brand
header band, flat sections split by a rule, rounded 40px controls, a sticky
action bar and matching dialogs. It is the same design as Sachiko's Sales Order
page.

| What | Where |
|---|---|
| Stylesheet | `public/css/salesOrderForm.css` |
| Reference markup | `views/inventory/orders/salesOrderForm.ejs` (top of the file, before the data `<script>` tags) |
| Loaded by | `CSS: FORM_STYLE_CSS` in `routes/fairdesk_route.js` (one constant holding `"salesOrderForm.css?v=N"`): Sales Order, Dispatch Order, the Label profile / create / edit pages, and the Tape / POS Roll / Tafeta / TTR create pages and profiles. List/profile pages whose `CSS` slot is already taken (or `false`) link it from the view instead, with an href the route passes as `formStyleHref` (Labels, Color Labels, Tape, POS Roll, Tafeta, TTR, and every page that opens the New Client dialog: `/client/view`, `/master/view`, `/client/profile/:id`, `/client/details/:userId`). |
| Form-dialog script | `public/js/soFormDialog.js` (see *Form-dialog behaviour* below) |
| File upload script | `public/js/soUpload.js` (see *File upload* below) |

Everything is scoped under `.so-page` (the design tokens are on `:root`), so
loading the stylesheet on a page changes nothing until that page's markup uses
the `so-` classes. The other forms in the app, built on common.css's global
`form` / `.span-*` rules, are unaffected.

---

## 1. Design tokens

All colours, radii and sizes come from these CSS variables (declared on `:root`
in `salesOrderForm.css`). Use the variables, never the raw values, so a change
in one place follows everywhere.

| Token | Value | Used for |
|---|---|---|
| `--so-bg` | `#f4f6fa` | Page background |
| `--so-surface` | `#ffffff` | Controls, bars, dialogs |
| `--so-line` | `#969faf` | Section dividers, heading underline, dropdown borders |
| `--so-line-soft` | `#a5acba` | Table cell lines, stat pills, panel borders |
| `--so-ink` | `#0f172a` | Main text, typed values |
| `--so-ink-soft` | `#475569` | Field labels, ghost buttons |
| `--so-muted` | `#2e3a4c` | Secondary text, dropdown chevron |
| `--so-faint` | `#4e5b6f` | Hints, table headings |
| `--so-brand` | `#044a78` | Brand blue: primary button, focus, active states, icons |
| `--so-brand-dark` | `#03365a` | Primary hover, header gradient end |
| `--so-brand-soft` | `#eef4fa` | Icon tiles, selected/hover tints |
| `--so-ring` | `rgba(4, 74, 120, 0.13)` | Focus ring |
| `--so-danger` | `#e11d48` | Required dot, errors, danger button |
| `--so-radius` | `16px` | Header band |
| `--so-radius-sm` | `10px` | Controls, buttons |
| `--so-field-h` | `40px` | Height of every input / select / button |
| `--so-field-border` | `#445a73` | Control border (deliberately strong, reads on shopfloor monitors) |
| `--so-field-border-hover` | `#30445c` | Control border on hover |
| `--so-placeholder` | `#2e3a4c` | Placeholder text |
| `--so-field-ro-bg` / `-ro-border` / `-ro-ink` | `#eaeff6` / `#707d8f` / `#222d3d` | Read-only fields: no white ground, softer edge, grey text |

**Type scale:** page title 26px/700 · section title 15px/700 · control text
13.5px/500 · label 12px/600 · hint and small print 11–12px. Numbers use tabular
figures (`font-variant-numeric: tabular-nums`) so columns of quantities line up.

**Status colours** (fixed, not tokens): warning `#fffbeb` / `#fde68a` / `#92400e`,
info `#f0f9ff` / `#bae6fd` / `#0369a1`, tag amber `#fef3c7` / `#b45309`.

---

## 2. Page skeleton

```html
<div class="main-content so-page">
  <form id="my-form" class="so-form" method="post" action="..." novalidate>
    <!-- hidden inputs (_csrf, ids, ...) -->

    <div class="so-sheet">
      <header class="so-hero">
        <div class="so-hero__text"><h1>Page Title</h1></div>
        <div class="so-hero__meta">
          <span class="so-chip so-chip--brand" title="PO Number">
            <i class="fa-solid fa-hashtag"></i><strong>PO-77</strong>
          </span>
          <span class="so-chip"><i class="fa-regular fa-calendar"></i>PO Date <strong>01 Sept 2026</strong></span>
        </div>
      </header>

      <!-- a titled section -->
      <section class="so-card">
        <div class="so-card__head">
          <span class="so-card__icon"><i class="fa-solid fa-layer-group"></i></span>
          <div class="so-card__titles"><h2 class="so-card__title">Section Title</h2></div>
          <div class="so-card__aside"><!-- optional: toggles / buttons on the right --></div>
        </div>
        <div class="so-grid">
          <!-- fields, see §4 -->
        </div>
      </section>

      <!-- an untitled section: opens straight on its fields -->
      <section class="so-card so-card--bare">
        <div class="so-grid"> ... </div>
      </section>
    </div>

    <div class="so-actions">
      <span class="so-actions__hint">
        <i class="fa-regular fa-circle-check"></i>
        <span class="so-actions__hint-text">One line of guidance.</span>
      </span>
      <button type="button" class="so-btn so-btn--ghost">Cancel</button>
      <button type="submit" class="so-btn so-btn--primary"><i class="fa-solid fa-check"></i> Save</button>
    </div>
  </form>
</div>
```

- **`.so-page`**: page background `--so-bg`, padding `18px 18px 0`.
- **`.so-form`**: a vertical stack (gap 16px) that fills the scroller, so the
  action bar sits on the bottom edge even when the form is short. It undoes
  common.css's global `form` border, padding and 32-column grid.
- **`.so-sheet`**: groups the header and the sections. It has no box of its own.
- **The action bar stays inside the `<form>`**, so the submit button still submits it.

---

## 3. Components

### Header band — `.so-hero`
The brand gradient (`--so-brand` → `--so-brand-dark`, with a soft white radial
highlight top-right), radius `--so-radius`, padding `20px 24px`, title in white.
The page title goes on the left and chips on the right; they wrap onto their own
line on narrow screens.

**Chips** (`.so-chip`, `.so-chip--brand` for the key value): 30px pills,
translucent white on the band, 12px text, value in `<strong>`. Use them for the
record's key facts (PO number, date, status).

### Sections — `.so-card`
- **Flat, not boxed.** A section sits straight on the page background. Consecutive
  sections are separated by a 1px `--so-line` rule (`.so-card ~ .so-card`). The
  selector is `~`, not `+`, so the rule survives an alert placed between two sections.
- **Heading row `.so-card__head`**: a 34px icon tile (`--so-brand-soft` ground,
  brand icon, radius 11px), the title at 15px/700, and optional right-hand items
  in `.so-card__aside`. The row is **underlined with a 2px `--so-line` rule**
  across the section, so it reads as a heading rather than as one more row of
  fields. It carries the side gutter with `margin: 0 20px`, so the line lines up
  with the fields.
- **Untitled section `.so-card--bare`**: use it when the fields name themselves
  (dates, numbers, remarks). It adds top padding in place of the heading.

### Resolved-value badge in a card head — `.so-card__badge`
For a value that's an **outcome** of the fields below it — a resolved SKU/ID,
a computed total — rather than one more field to fill in. It sits directly in
`.so-card__head`, between `.so-card__titles` and `.so-card__aside`, **never
inside `.so-grid`**: that keeps the field row's own 32-column math fixed no
matter how wide the badge ends up needing to be. Example: the Client Label
form's SKU ID, which resolves from the Instructions/Width/Height/Gap row in
the same "Label Specifications" section.
```html
<div class="so-card__head so-card__head--wrap">
  <span class="so-card__icon"><i class="fa-solid fa-ruler-combined"></i></span>
  <div class="so-card__titles"><h2 class="so-card__title">Label Specifications</h2></div>
  <div class="so-card__badge" title="Resolves once Instructions, Width, Height and Gap match one Label Master">
    <span class="so-card__badge-label">SKU ID</span>
    <input type="text" id="product-id" name="productId" class="so-card__badge-input" placeholder="Will appear here" readonly required />
  </div>
  <div class="so-card__aside"><!-- e.g. a Reset .so-toggle --></div>
</div>
```
- **Look**: a 30px pill, brand-soft ground, brand text, centred — distinct
  from a `.form-control` (it isn't one, and carries no `.form-control` class)
  since it lives outside the grid's field paint entirely.
- **`.so-card__head--wrap`**: add this modifier to the specific head that
  carries a badge, not to `.so-card__head` generally — most heads have
  nothing to wrap for. It lets the row wrap so the badge can drop to its own
  line next to a narrow aside button instead of overflowing on a small
  screen; most heads don't need it.
- **State colours are the page's own CSS, id-scoped.** The shared pill paint
  is the same everywhere; a page that needs to swap colours for a
  resolved/error state (the SKU ID turning green/red) layers its own rule on
  top, keyed by the field's `id` plus a state class — e.g.
  `#product-id.label-id-success`. An id-qualified selector always outranks
  one with only classes attached, regardless of source order, so this beats
  `.so-card__badge-input`'s shared paint without `!important`.
- **Still a real field**: `readonly`/`required` behave exactly as on any
  other input — it posts with the form and participates in validation same
  as a `.so-grid` field would.

### Field grid — `.so-grid`
- **32 columns**, gap `16px 14px`, padding `14px 20px 20px`.
- **Fields are direct children** using common.css's span classes: `span-three` …
  `span-eight` (3–8 columns), `span-dual` (8), `span-penta` (10), `span-hexa` (12),
  `span-half` (16), plus `so-full` / `span-full` for a full row. Here they are
  stripped to a plain label-over-control column, with no box of their own.
- **Every row must add up to 32.** Any width without a named class (1, 2, 9, 11,
  ...) keeps a span class for the field styling and sets the width inline:
  `class="span-eight" style="grid-column: span 9;"`. There is no `span-two` in
  FAIRTECH's common.css.
- **Dates need at least `span-four`.** A date field can't end in "…" (the browser
  draws its text), and at 3 columns it is too narrow at the smallest full-grid width.
- If the page's JS re-spans a field (e.g. `syncRemarksWidth()`), keep the
  arithmetic in the markup comment next to it.

### Fields
```html
<div class="span-four">
  <label for="po-number"><span class="so-label-text">PO Number</span></label>
  <input type="text" id="po-number" name="poNumber" class="form-control" placeholder="Enter PO number" required />
</div>
```
- **Label**: 12px/600 `--so-ink-soft`, one line. **Always wrap the words in
  `<span class="so-label-text">`**: the label is a flex row, and only an element
  that owns its text can end in "…".
- **Required marker**: a 5px red dot added automatically after the label of any
  control with `required`, via `:has()`. Nothing to add by hand. It follows JS
  that toggles `required`, including selects that Choices.js has re-parented.
- **Badge in a label** (e.g. `#qty-unit-badge`): a sibling after the text span. It
  never shrinks.
- **Control `.form-control`**: 40px, radius 10px, 1px `--so-field-border`, white
  ground. Hover darkens the border; focus is a brand border plus a 3.5px `--so-ring`.
- **Read-only (`readonly`)**: grey ground, softer border, grey text, default cursor.
- **Validation**: Bootstrap / BTStrap tick and cross icons are removed. Only a real
  error shows, as a `--so-danger` border.
- **Selects** get a drawn chevron. With Choices.js, `.choices__inner` is painted
  the same as a plain input (40px, same border and focus ring), the dropdown is a
  12px-radius card with an 8px-radius highlighted row, and the search box sits
  inside it. Blank-valued items render as placeholders.

### Alerts — `.so-alert`
```html
<div class="so-alert so-alert--warn"><i class="fa-solid fa-triangle-exclamation"></i><span>Message</span></div>
```
`--warn` (amber), `--info` (sky), `--stack` (head plus rows, full width). They
have padding `12px 16px`, radius 12px and 13px text. An alert placed between
sections, not inside a grid, needs the side gutter (`margin: 0 20px 16px`, see
`#stock-warning`).

### Buttons — `.so-btn`
40px, radius 10px, 13.5px/650, icon at 12px.
- **`--primary`**: brand fill with a soft brand shadow. Hover is `--so-brand-dark`;
  disabled is `#9fb3c4`.
- **`--ghost`**: white with a field-border outline.
- **`--danger`**: `--so-danger` fill.

A press nudges the button down 1px.

### Toggles — `.so-toggle` (on/off buttons in a heading)
32px pill, white with a field-border outline; hover goes brand-soft. The on
state `.active` is a brand fill with white text. It sets its own colours
because common.css has a bare global `.active { background-color: #03365a }`.

### Sliding switch — `.so-switch` (exactly two modes)
```html
<div class="so-switch" role="tablist" aria-label="Mode">
  <span class="so-switch__thumb"></span>
  <button type="button" class="so-switch__opt active" role="tab" aria-selected="true">First</button>
  <button type="button" class="so-switch__opt" role="tab" aria-selected="false">Second</button>
</div>
```
Use this, not two `.so-toggle` pills, when the two options are a single
setting with exactly two positions (Individual/Common, Create Client/Create
User) rather than independent on/off switches. A brand-filled thumb
(`.so-switch__thumb`) slides under whichever `.so-switch__opt` is active —
reads as "one setting, two positions" at a glance the way separate buttons
don't. The thumb is exactly half the switch's content box, so moving it to
the second position is always `transform: translateX(100%)` — this only
works for exactly two options.

Drive it with your own toggle script: add `.so-switch--<second>` (e.g.
`.so-switch--common`) to `.so-switch` itself when the second option is
active, alongside `.active`/`aria-selected` on the buttons — see the New
Color Label dialog's `data-clm-tab` handler, or the New Client dialog's
`data-ccf-tab` handler (`views/users/_clientForm.ejs`), which drives two
copies of the switch (one per form's head) from one shared handler.

If a switch's active option is reliably always the *last* `.so-switch__opt`
in the DOM, `.so-switch:has(.so-switch__opt:last-child.active)` can drive the
same slide with no JS of your own to write, for the rare case where you don't
control the toggle script at all (e.g. it lives in a different, shared file).
Prefer owning the toggle script when you can — it's one line to add, and
doesn't depend on DOM order staying exactly as a selector expects.

**On a page, not just in a dialog**: `.so-switch` works directly on a
`.so-page` hero as well as in a `.so-dialog__head`. Add `.so-switch--on-brand`
wherever it sits on the brand-blue ground (a hero or a dialog head) — the
default grey track and blue thumb would both vanish against it, so this
variant repaints it the same translucent-white-on-blue language those
grounds' own icon tiles use: a frosted track, solid white thumb, blue (not
white) text on the active option.

### File upload — `.so-upload`
```html
<div class="span-hexa" style="grid-column: span 11;">
  <label for="jpg-file"><span class="so-label-text">JPG File</span></label>
  <div class="so-upload" data-so-upload data-icon="fa-solid fa-file-image" data-placeholder="Choose JPG file">
    <input type="file" id="jpg-file" class="so-upload__input" name="jpgFile" accept=".jpg,.jpeg,image/jpeg" />
    <div class="so-upload__control">
      <span class="so-upload__icon"><i class="fa-solid fa-cloud-arrow-up"></i></span>
      <span class="so-upload__text">Choose JPG file</span>
    </div>
    <button type="button" class="so-upload__clear" hidden tabindex="-1" title="Remove file"><i class="fa-solid fa-xmark"></i></button>
  </div>
</div>
```
A plain `<input type="file">` carries no `.form-control` paint anywhere in the
app (the browser's own button + "no file chosen" text can't be restyled to
match), so a field that takes a file gets this component instead.

- **How it works**: the real `<input>` is full-size (`inset: 0`) and sits on
  top of the label, just painted invisible (`opacity: 0`, never
  `display:none`/`hidden`) — so it stays focusable and in the tab order, and a
  click or keyboard Enter/Space opens the native file picker exactly as it
  would on a bare input. `.so-upload__control` underneath is pure paint: a
  dashed-border box (40px, matching every other control) with an icon and a
  label that reads as a placeholder until a file is picked.
- **States**: empty shows the `data-placeholder` text (default "Choose file")
  in placeholder ink with a generic upload icon; picking a file adds
  `.so-upload--filled` — solid border, full-ink bold filename (truncated with
  "…", full name on hover), and the icon swaps to `data-icon` (a file-type
  icon, e.g. `fa-file-pdf`) if given, else a generic file icon. The × clear
  button appears only once filled.
- **Clear button stacking**: it sits at a higher z-index than the overlay
  input so a click on it reaches the button instead of reopening the file
  picker — needed because the input's `inset: 0` covers the whole row,
  including the button's own footprint.
- **Required**: put `required` on the real `.so-upload__input`; the label's
  automatic red dot (`:has(~ [required])`) matches it like any other field,
  and native `checkValidity()` treats an empty file input exactly like an
  empty text input.
- **Behaviour — `public/js/soUpload.js`**: add `data-so-upload` to the wrapper
  and load the script once per page; it reflects the input's `change` (and
  the clear button) onto the label/icon and is safe to call again
  (`window.soUpload.init(container)`) for a field added after page load (a
  dialog opened later). Nothing to wire by hand per field. It also listens for
  the containing `<form>`'s `reset` event (which `soDialog.open()` fires via
  `form.reset()`, and which clears the real input's value without ever firing
  `change` on a file input) and re-syncs from there — so a dialog's upload
  field doesn't keep showing a stale filename after the form resets.

### Sub-panel — `.so-subpanel` (a block that opens under a section's fields)
```html
<div id="extra-fields" class="so-subpanel" style="display:none;">
  <div class="so-subpanel__head"><i class="fa-solid fa-plus"></i> Extra</div>
  <div class="so-grid"> ...fields... </div>
</div>
```
`#f8fafc` ground, 1px `--so-line-soft` border, radius 12px, margin `0 20px 20px`.
The heading is 11px uppercase brand text over the same 2px `--so-line`
underline. JS shows it with `display: flex`. Its fields are a `.so-grid` of
their own (padding 0), so they get every field rule for free.

### Sticky action bar — `.so-actions`
Stuck to the bottom and full-bleed. The ground is 90% white with a 12px
backdrop blur and a 1px top rule. The hint on the left (`.so-actions__hint`,
`flex: 1 1 0`) takes only the space the buttons leave and truncates there, so a
long hint never pushes the buttons onto a second line. Buttons sit on the right.

### Dialogs — `.so-dialog`
```html
<div id="x-dialog" class="so-dialog-backdrop">           <!-- JS: style.display = "flex" -->
  <div class="so-dialog">                                  <!-- 440px; --sm = 400px; --lg = 620px -->
    <div class="so-dialog__head">
      <span class="so-dialog__icon"><i class="fa-solid fa-pencil"></i></span>   <!-- --danger variant -->
      <div><h3 class="so-dialog__title">Title</h3><p class="so-dialog__desc">One line.</p></div>
    </div>
    <div class="so-dialog__body">
      <div class="so-dialog__field"><label for="f">Label <span class="so-req">*</span></label><input id="f" /></div>
    </div>
    <div class="so-dialog__foot">
      <button type="button" class="so-btn so-btn--ghost">Cancel</button>
      <button type="button" class="so-btn so-btn--primary">Save</button>
    </div>
  </div>
</div>
```
- **Look**: a dimmed, 3px-blurred backdrop; a white card with 16px radius and a
  pop-in animation; a grey footer strip.
- **Blue header**: every dialog's head (`.so-dialog__head`) has a flat brand-blue
  background (`--so-brand`), the same bar the app's other dialogs use (Add
  Employee, Mark Inactive). On it:
  - the title (`.so-dialog__title`) is white, 15px/700;
  - the one-line description (`.so-dialog__desc`) is white at 78% opacity, 12px;
  - the icon (`.so-dialog__icon`) sits on a translucent white tile
    (`rgba(255, 255, 255, 0.14)`) and is white;
  - a destructive dialog uses `.so-dialog__icon--danger`, which keeps a solid
    light-red tile with a red icon, so delete and cancel dialogs stand apart;
  - there is no divider line: the change from blue head to white body is the
    separation, and the card's `overflow: hidden` rounds the head's top corners.

  Always give a dialog a head with an icon and a title. The description is
  optional: use it only for the one consequence worth knowing before you act
  ("Stock will be reversed. This cannot be undone."), and leave it out when the
  title says enough (the New Master Label dialog has none).
- **Styled without `.so-page`**: dialogs usually render outside the page wrapper,
  so they carry their own copy of the field and button paint. That is also why a
  dialog can be used on a page that isn't built in this style at all (see the
  Labels Master dialog below).
- **Closing**: only Cancel, the × or Esc close a dialog. A stray backdrop click
  must not discard a part-filled form.
- **Stacking**: the backdrop is at z-index 9998, one below the layout's toasts
  (9999), so an error toast raised while a dialog is open shows on top of it.

**A dialog that holds a form.** Make the `<form>` itself the card, so the
submit button in the footer submits it. `form.so-dialog` undoes common.css's
global form grid, border and padding.
```html
<div id="label-master-dialog" class="so-dialog-backdrop" aria-hidden="true">
  <form id="label-master-form" class="so-dialog" action="/fairtech/form/label-master" method="post" novalidate>
    <div class="so-dialog__head"> ... </div>
    <div class="so-dialog__body">
      <div class="so-dialog__field">
        <label for="lm-label-id">Label ID</label>
        <input type="text" id="lm-label-id" name="labelProductId" readonly />      <!-- read-only paint -->
      </div>
      <div class="so-dialog__row">                                                   <!-- equal columns -->
        <div class="so-dialog__field"><label for="lm-width">Width <span class="so-req">*</span></label><input id="lm-width" required /></div>
        <div class="so-dialog__field"><label for="lm-height">Height <span class="so-req">*</span></label><input id="lm-height" required /></div>
        <div class="so-dialog__field"><label for="lm-gap">Gap <span class="so-req">*</span></label><input id="lm-gap" required /></div>
      </div>
    </div>
    <div class="so-dialog__foot">
      <button type="button" class="so-btn so-btn--ghost">Cancel</button>
      <button type="submit" class="so-btn so-btn--primary"><i class="fa-solid fa-check"></i> Save</button>
    </div>
  </form>
</div>
```
- **Fields side by side**: `.so-dialog__row` holds any number of `.so-dialog__field`s
  in equal columns, and is spaced from its neighbours the way a field is.
- **Grouping a long form**: `.so-dialog__section` is a small uppercase divider
  (a rule above, brand-coloured text) for breaking a field-heavy dialog into
  named groups — e.g. the New Color Label dialog's "User Information" /
  "Color Label Specifications" / "Cost & Pricing" / ... Skip it for a short
  dialog; it exists for the rare one that's genuinely long.
- **Size**: 440px by default. `.so-dialog--sm` (400px) is for confirmations.
  `.so-dialog--lg` (620px) suits a longer form, such as rows of three (the
  Tape / POS Roll / Tafeta / TTR Master dialogs). `.so-dialog--xl` (1080px) is
  for a field-heavy form that reads better as 4 columns than 2–3 (the New
  Color Label dialog's Individual tab).
- **Tall dialogs scroll, not overflow**: `.so-dialog` caps itself at
  `calc(100vh - 40px)` and is a column flexbox; the head/tabs/foot stay put
  (`flex: none`) while `.so-dialog__body` (`flex: 1 1 auto; overflow-y: auto`)
  scrolls. A short dialog never notices this — it just never reaches the cap.
- **Selects**: a plain `<select>` in a dialog is painted like the inputs (40px,
  radius 10px, the same border and focus ring) with its own chevron. A required
  select still on its blank "Select" option reads as a placeholder. A
  Choices.js-enhanced select works too — `.choices` inside `.so-dialog` gets
  the same paint as `.choices` inside `.so-page` (see Choices.js below); its
  open dropdown already carries the `z-index: 99999` a dialog needs.
- **Required fields**: mark them `<span class="so-req">*</span>` in the label by
  hand — dialog labels don't get the grid's automatic dot (`:has()` needs the
  control to be a plain sibling of the label, which isn't always true in a
  dialog — GST's "Unregistered" checkbox row, for one). `.so-req` renders as
  the same small red dot either way: the literal "*" text is hidden
  (`font-size: 0`) and a 5px circle drawn in its place, so it reads identically
  to the grid's automatic one despite the different mechanism.
- **Read-only (`readonly`)**: the same grey paint as the page's read-only fields.
- **Validation**: a field that failed gets `.so-invalid` (red edge, and it stays
  red while focused), removed again on input. There is no Bootstrap tick or cross.
- **Labels** are one line, with "…" when they don't fit.
- **Safe on Tabulator pages**: dialog inputs and selects set their background
  with `!important`, which beats tableDisp.css's bare
  `input { background-color: ... !important }`. Its `height: 20px` loses to the
  dialog's own 40px on specificity.

**Form-dialog behaviour — `public/js/soFormDialog.js`.** Don't write a submit
handler per dialog: add `data-so-form` to the `form.so-dialog` and load the
script after the markup. It gives every such form:
- **Validation on submit**: every `[required]` input, select or textarea must be
  non-blank once trimmed (a lone space passes the browser's `required`). Failures
  get `.so-invalid` and one toast naming them ("Please fill in Width, Height."),
  and nothing is sent.
- **Submit**: `fetch` with `Accept: application/json`. The body is multipart when
  the form has `enctype="multipart/form-data"` and urlencoded otherwise. **Match
  the route**: only a route with a multipart parser (e.g. one that takes
  uploads) can read multipart; any other gets an empty body.
- **The route's answer**: `{ success: true, redirect }` → go there (the route's
  flash toasts on arrival); `{ success: false, message }` → `showToast(message)`
  and stay, with the entries kept. The submit button shows a spinner and is
  disabled while saving. A route that only redirects today needs a JSON branch
  for fetch requests (`req.xhr || accept includes application/json`), with the
  redirects left in place for native form posts.
- **Opening and closing** (forms inside a `.so-dialog-backdrop`):
  `soDialog.open('<backdrop id>')` resets the form to what the page rendered
  (`form.reset()`: create defaults, or the record's saved values) and focuses the
  field marked `data-so-autofocus`, else the first editable one.
  `soDialog.close('<backdrop id>')` is for the Cancel button; Esc closes the open
  dialog; a backdrop click never does; nothing closes while saving.
- **Tooltip**: the full text on hover for any label or field cut short with "…".
- **Safe to load more than once** (each form is bound once).
- **Don't add `needs-validation`** to such a form: `BTStrap.js` binds its own
  fetch-submit to every `.needs-validation` form, so it would submit twice.

**The same card as a page.** For anyone who lands on a create or edit URL
directly, render the same form card without a backdrop, inside
`<div class="so-dialog-page">` (centred on the page background). Its Cancel is
a link (`<a class="so-btn so-btn--ghost" href="...">`) back to where the dialog
would have been opened.

**A dialog with two flows (in-dialog switch).** Every dialog above is one
`<form>`. The New Color Label dialog is the one exception: it keeps the old
standalone page's Individual (type a full spec and bind it to a client in one
submit) and Common (master spec only) flows, switched by a sliding segmented
control — because that combined create+bind flow has no other home in the
app. Use this pattern only when a dialog genuinely needs more than one
distinct submit target; don't reach for it just to group fields (use
`.so-dialog__section` for that).
```html
<div id="x-dialog" class="so-dialog-backdrop">
  <form id="x-individual" class="so-dialog so-dialog--xl" action="/a" data-so-form>
    <div class="so-dialog__head">
      <span class="so-dialog__icon">...</span>
      <div><h3 class="so-dialog__title">Title</h3><p class="so-dialog__desc">...</p></div>
      <div class="so-switch so-switch--on-brand" data-x-switch role="tablist" aria-label="Create mode">
        <span class="so-switch__thumb"></span>
        <button type="button" class="so-switch__opt active" data-x-tab="individual" role="tab" aria-selected="true">Individual</button>
        <button type="button" class="so-switch__opt" data-x-tab="common" role="tab" aria-selected="false">Common</button>
      </div>
    </div>
    <div class="so-dialog__body">...</div>
    <div class="so-dialog__foot">...</div>
  </form>
  <form id="x-common" class="so-dialog so-dialog--xl" action="/b" data-so-form style="display: none;">
    <!-- same head styling, its own .so-switch, with "common" active and
         .so-switch--common on the .so-switch itself -->
  </form>
</div>
```
- **Two separate `<form>`s, not one with two hidden panels.** If the two flows
  share any field names (very likely — both post a `jobName`, both take the
  same attachments), one `<form>` would submit both panels' same-named fields
  at once: `FormData`/`new URLSearchParams(new FormData(form))` collects every
  named control regardless of `display: none`. Two forms means only the
  visible one's fields are ever sent.
- **Both forms carry `data-so-form`.** soFormDialog.js binds each one
  independently — validation, submit and the saving-spinner all work per form
  with no extra code. Only `soDialog.open()`/`close()` and `isSaving()` look at
  a *single* `form[data-so-form]` inside the backdrop (the first one in the
  DOM), so write any tab-switch logic defensively: don't assume the dialog's
  open/close/saving state tracks whichever form is currently showing.
- **A sliding switch (`.so-switch`)**, not two independent buttons or a toolbar
  row of its own — see "Sliding switch — `.so-switch`" above for the
  component itself. It sits directly in the head (`margin-left: auto` pushes
  it right of the title/description): a dialog can't spare a whole extra row
  of height just to hold a two-way switch.
- **The switch is duplicated in both forms' heads**, each with its own
  `.so-switch`/`active`/`aria-selected` state, kept in sync by one shared
  click handler keyed on a data attribute (`data-x-tab` above) — see
  `_colorLabelMasterForm.ejs`'s or `_clientForm.ejs`'s inline `<script>`.
  Switching only toggles which form's `display` is `flex` / `none`; it never
  resets either form's fields.
- **Reset both on open, not just the one `soDialog.open()` resets.** It only
  calls `form.reset()` on the first form in the DOM. Give the opening
  function's own code an explicit `document.getElementById('<other form
  id>').reset()` (and, if the dialog has its own deep-link entry point like
  `_clientForm.ejs`'s `window.openClientFormDialog(tab, clientName)`, call it
  there too) before `soDialog.open(...)`, so a stale fill from a cancelled
  previous open doesn't linger on the tab that isn't first. A field whose
  value a reset can't fully undo on its own (a Choices.js selection, a
  repeater's row count, a checkbox-driven `readOnly`/`required` toggle) needs
  its own `reset` event listener on the form to re-sync it — see
  `_clientForm.ejs`'s GST-unregistered and location-repeater listeners.
- **Give both forms the same fixed `height`.** Two forms with different field
  counts naturally settle to different heights, so flipping the switch would
  otherwise resize the whole dialog. Set an explicit `height` (not just the
  inherited `max-height`) on both forms' ids, sized to the taller one's
  content — the shorter form just carries blank space below it, and
  `.so-dialog__body`'s own `overflow-y: auto` still absorbs anything that
  turns out taller than expected (see `#clm-individual-form,
  #clm-common-form` in salesOrderForm.css).

**One partial per form.** Keep the card in one EJS partial (a create / edit
`mode` and a `standalone` flag), included by the list page (dialog), the
profile page (edit dialog) and the standalone pages (page card), so the three
can never drift. Pass the partial one object (e.g. `lm`, `tm`, `pm`, `fm`, `rm`)
so its locals can't collide with the page's own. In edit mode a select offers
the create form's options plus the record's saved value if that isn't among
them, so opening and saving never swaps an old value for the first option.

References:
| Dialog | Opened from | Partial | Posts to |
|---|---|---|---|
| New Master Label | "+ Label" on `/fairtech/labels/view` | `views/inventory/labels/_labelMasterForm.ejs` (create) | `POST /form/label-master` (multipart) |
| Edit Master Label | "Edit Label" on `/fairtech/labels/profile/:id` (plain labels) | same partial (edit, pre-filled) | `POST /labels/edit/:id` (urlencoded, JSON for fetch) |
| New Tape Master | "+ Tape" on `/fairtech/tape/view` | `views/inventory/tape/_tapeMasterForm.ejs` (`tm`) | `POST /form/tape` (urlencoded) |
| Edit Tape Master | "Edit Tape" on `/fairtech/tape/profile/:id` | same partial (edit, pre-filled) | `POST /tape/edit/:id` (urlencoded, JSON for fetch) |
| New POS Roll Master | "+ POS Roll" on `/fairtech/pos-roll/view` | `views/inventory/posRoll/_posRollMasterForm.ejs` (`pm`) | `POST /form/pos-roll-master` (urlencoded) |
| Edit POS Roll Master | "Edit POS Roll" on `/fairtech/pos-roll/profile/:id` | same partial (edit, pre-filled) | `POST /pos-roll/edit/:id` (urlencoded, JSON for fetch) |
| New Tafeta Master | "+ Tafeta" on `/fairtech/tafeta/view` | `views/inventory/tafeta/_tafetaMasterForm.ejs` (`fm`) | `POST /form/tafeta-master` (urlencoded) |
| Edit Tafeta Master | "Edit Tafeta" on `/fairtech/tafeta/profile/:id` | same partial (edit, pre-filled) | `POST /tafeta/edit/:id` (urlencoded, JSON for fetch) |
| New TTR Master | "+ TTR" on `/fairtech/ttr/view` | `views/inventory/ttr/_ttrMasterForm.ejs` (`rm`; Core Length follows Width, as on the old form) | `POST /form/ttr` (urlencoded) |
| Edit TTR Master | "Edit TTR" on `/fairtech/ttr/profile/:id` | same partial (edit, pre-filled; Core Length follows Width only while the two are equal) | `POST /ttr/edit/:id` (urlencoded, JSON for fetch) |
| New Color Label | "+ Color Label" on `/fairtech/color-labels/view` | `views/inventory/labels/_colorLabelMasterForm.ejs` — two forms + an in-dialog Individual/Common tab bar (see "A dialog with two flows" above); no edit dialog or standalone page | Individual → `POST /form/color-labels/create` (multipart); Common → `POST /form/color-label-master` (multipart) |
| New Client | "+ Client" / "+ User" on `/fairtech/client/view` and `/fairtech/master/view`; "Add User" on `/fairtech/client/profile/:id` and `/fairtech/client/details/:userId` (pre-selects that client and jumps to the User tab via `window.openClientFormDialog('user', clientName)`) | `views/users/_clientForm.ejs` — two forms + an in-dialog Create Client/Create User switch; no edit dialog or standalone page | Create Client → `POST /form/client` (urlencoded); Create User → `POST /form/user` (urlencoded) |

The standalone pages `/fairtech/form/label-master`, `/fairtech/labels/edit/:id`,
`/fairtech/form/tape-master`, `/fairtech/form/pos-roll-master`,
`/fairtech/form/tafeta-master` and `/fairtech/form/ttr` render the same
partials as page cards.

**Edit dialogs on the shared item profile.** Tape, POS Roll, Tafeta and TTR
profiles all render `views/inventory/itemView.ejs`. A route that passes
`editMaster: { label, dialogId, partial, locals }` gets an "Edit <label>"
button in the header and the partial included in edit mode; a route that
doesn't (e.g. the paper profile) gets neither.

An edit dialog must not send `status`: the edit routes (`/labels/edit/:id`,
`/tape/edit/:id`, `/pos-roll/edit/:id`, `/tafeta/edit/:id`, `/ttr/edit/:id`)
are also where the profile's Change Status dialog posts, and they tell the two
apart by what is sent. The four item routes treat a post that carries any spec
field as a spec edit and anything else as the status change it always was.
Spec edits go through `updateMasterSpec` in `routes/fairdesk_route.js`, with
one spec object per item (`TAPE_MASTER_SPEC`, `POS_ROLL_MASTER_SPEC`,
`TAFETA_MASTER_SPEC`, `TTR_MASTER_SPEC`). It applies the create route's
normalisation and duplicate rules against every other master, recomputes the
stored signature, and runs the model's validators. For a tape, a Finish change
is also copied onto its `TapeStock` rows.

### Record-specific parts (see the stylesheet for exact values)
- **Stock / location bar `#stock-display`**: a white card of radio pills with
  Total / Booked / Balance stat pills. Disabled pills are dimmed with a
  not-allowed cursor. "ALL" is a total, never a choice.
- **Spec table `.ap-table`** inside `#selected-item-details`: fixed layout,
  uppercase 10.5px headings, `.ap-hl` for highlighted cells.
- **Dispatch log `.so-log-row`**: one line per entry, with `.so-log-invoice`
  (monospace chip), `.so-log-tag` (amber) and `.so-log-note`.

---

## 4. Long text: one line and "…", full text on hover

Anywhere text can outgrow its box, it stays on one line and ends in "…"
instead of wrapping, spilling or being hard-clipped:
- labels, typed values and the selected dropdown value;
- every dropdown option;
- header chips and stock-bar location names;
- spec-table cells, dispatch-log invoice and note;
- the action-bar hint.

Rules of thumb:
- **Flex containers can't end in "…".** Put the text in its own element (a span)
  with `min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap`.
- **A shrinking flex item needs `min-width: 0`** (e.g. `.choices__list--single`),
  or it refuses to shrink below its content.
- **Sentences (warnings, messages) wrap**, because they have to be read in full.
- **Date inputs can't truncate**, so give them enough columns (see §3, Field grid).
- **Full text on hover**: a small delegated script in the view (just before the
  data `<script>` tags in `salesOrderForm.ejs`) sets a `title` on any of those
  elements, but only while it is actually cut off, and removes it once the text
  fits. If you add a new truncating element, add its selector to that script's
  `TRUNCATING` list.

---

## 5. Responsive

| Width | Behaviour |
|---|---|
| ≤ 1280px | Grid drops to 4 equal columns. Every field spans 1 (`!important`, because JS writes inline `grid-column`). Full-row items stay full. |
| ≤ 1100px | Action-bar hint hidden |
| ≤ 1024px | `.contain` height corrected so the sticky bar isn't cut off below the nav |
| ≤ 900px | Grid drops to 2 columns |
| ≤ 620px | 1 column; tighter gutters (14px); smaller header; buttons share the bar's full width |

The 32 columns carry 31 gaps, so below about 1280px the grid can't be squeezed
further. It switches to fewer, equal columns instead.

---

## 6. Global CSS this design has to beat

These rules apply to every page. The stylesheet overrides each one inside
`.so-page`; any new component must do the same.

| Global rule | Where | What it does if not overridden |
|---|---|---|
| `form { display: grid; grid-template-columns: repeat(32, 1fr); border: 2px solid ...; padding }` | common.css | Stacks the form's sections into a single narrow column with a blue border |
| `.span-* { border; padding; ... }` and `.span-* input` blue borders | common.css | Every field turns into a bordered box |
| `select { height: 2.3rem }` | common.css | Selects sit shorter than inputs |
| `.active { background-color: #03365a }` (bare, global) | common.css | Anything toggled `.active` turns navy — set its colours explicitly |
| `.choices[data-type*="select-one"]::after { display: none !important }` | common.css | No dropdown chevron (the stylesheet draws its own) |
| Choices' `word-break: break-all` on options | choices.min.css | Long options split mid-word over several lines |
| `input { height: 20px; background-color: #f8f9fa !important }` | tableDisp.css (only when `CSS: "tableDisp.css"`) | Crushed inputs — pin height and background with `!important` |
| `.is-valid` / `.is-invalid` tick and cross icons | Bootstrap / BTStrap.js | A green tick on every field anyone tabbed through |

---

## 7. Using this style on another page

1. **Load the stylesheet**: in the route, `CSS: FORM_STYLE_CSS`. If the route's
   single `CSS` slot is already taken (e.g. `tableDisp.css` on a Tabulator list
   page), pass ``formStyleHref: `/css/${FORM_STYLE_CSS}` `` and link it from the
   view: `<link href="<%= formStyleHref %>" rel="stylesheet" />`. Its selectors are
   all `.so-`-prefixed or tied to Sales Order element ids (`#stock-display`,
   `#client-name-div`, ...), so on another page they do nothing unless that page
   uses them. If you edit the stylesheet, **bump the `?v=` in `FORM_STYLE_CSS`**
   (one place, at the top of `routes/fairdesk_route.js`), or browsers keep the
   cached copy.
   *(If the style spreads to several pages, move the generic sections —
   tokens, shell, header, sections, grid, labels, controls, Choices, alerts,
   buttons, action bar, dialogs, long text, responsive — into a shared
   `formStyle.css` and keep only record-specific rules in the page file.)*
2. **Wrap the view**: `<div class="main-content so-page">` → `<form class="so-form">` →
   `<div class="so-sheet">`, then header, sections and the action bar (§2).
3. **Build rows that add up to 32** with the span classes. Dates get `span-four`
   or more.
4. **Wrap every label's words** in `<span class="so-label-text">`, and mark real
   requirements with `required` (the red dot follows automatically).
5. **Use `.so-btn`, `.so-toggle`, `.so-alert` and `.so-dialog`** rather than
   inline-styled buttons and boxes. No inline colours: use the tokens.
6. **Copy the hover-tooltip script** from `salesOrderForm.ejs` if the page has
   truncating text.
7. **Check it** at about 1500px, 1281px (the narrowest full grid, with the side
   nav), 1100px, 900px and 420px, in every mode the page has (create, edit,
   confirm...).

**Don't:**
- give sections their own boxes or shadows (they're flat, split by rules);
- flatten the 32-column grid;
- put inline `style` colours on controls;
- hide text overflow with plain clipping;
- close dialogs on a backdrop click.
