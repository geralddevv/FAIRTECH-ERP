import Username from "../models/users/username.js";
import Label from "../models/inventory/labels.js";
import ColorLabel from "../models/inventory/colorLabel.js";
import TtrBinding from "../models/inventory/ttrBinding.js";
import TapeBinding from "../models/inventory/tapeBinding.js";
import PosRollBinding from "../models/inventory/posRollBinding.js";
import TafetaBinding from "../models/inventory/tafetaBinding.js";
import { getUserLocationNames, normalizeLocationName } from "./locations.js";

const BINDING_TYPES = [
  [Label, "label"],
  [ColorLabel, "colorLabel"],
  [TtrBinding, "ttr"],
  [TapeBinding, "tape"],
  [PosRollBinding, "posRoll"],
  [TafetaBinding, "tafeta"],
];

/*
 * Call after a user's locationDetails are saved (e.g. a location was renamed
 * or removed) to re-point any of their item bindings whose `location` no
 * longer matches any of the user's current locations — otherwise those
 * bindings silently disappear from every location-scoped view (see
 * scripts/fix-orphaned-item-locations.js, which this mirrors for one-off
 * backfills of pre-existing bad data).
 *
 * Only auto-fixes when the user now has exactly ONE location, since that's
 * the only case where the correct target is unambiguous. Users with multiple
 * locations get their mismatched bindings reported back as `ambiguous`
 * instead of guessed at — the caller can surface that for manual review.
 */
export async function reconcileUserBindingLocations(userId) {
  const user = await Username.findById(userId)
    .select("locationDetails userLocation label colorLabel ttr tape posRoll tafeta")
    .populate(BINDING_TYPES.map(([, field]) => ({ path: field, select: "location" })))
    .lean();

  if (!user) return { fixed: [], ambiguous: [] };

  const validLocs = getUserLocationNames(user);
  const fixed = [];
  const ambiguous = [];

  for (const [Model, field] of BINDING_TYPES) {
    const items = user[field] || [];
    const ops = [];

    for (const item of items) {
      if (!item) continue;
      const itemLoc = normalizeLocationName(item.location);
      if (validLocs.includes(itemLoc)) continue; // already matches, nothing to do

      if (validLocs.length === 1) {
        ops.push({ updateOne: { filter: { _id: item._id }, update: { $set: { location: validLocs[0] } } } });
        fixed.push({ type: field, id: item._id, from: item.location, to: validLocs[0] });
      } else {
        ambiguous.push({ type: field, id: item._id, location: item.location, validLocs });
      }
    }

    if (ops.length) {
      await Model.collection.bulkWrite(ops, { ordered: false });
    }
  }

  return { fixed, ambiguous };
}

const IDENTITY_BINDING_TYPES = [
  [Label, "label"],
  [ColorLabel, "colorLabel"],
];

/*
 * Label/ColorLabel bindings (unlike Tape/TTR/POS Roll/Tafeta) don't reference
 * the owning user live via userId — they store their own denormalized copy
 * of clientName/userName/userContact, captured at binding-creation time. If
 * the user's name or contact is edited afterward, those bindings keep the
 * OLD values forever unless something re-syncs them — e.g. pages like
 * /labels/view/:id read straight off the binding, not the live Username doc.
 *
 * Call after a user's core identity fields are saved to push the current
 * values onto all of that user's Label/ColorLabel bindings. Unlike location
 * reconciliation there's no ambiguity here — the live user record is always
 * the single correct source — so this always fixes every mismatch found.
 */
export async function syncLabelBindingIdentity(userId) {
  const user = await Username.findById(userId)
    .select("clientName userName userContact label colorLabel")
    .populate(IDENTITY_BINDING_TYPES.map(([, field]) => ({ path: field, select: "clientName userName userContact" })))
    .lean();

  if (!user) return { fixed: [] };

  const fixed = [];

  for (const [Model, field] of IDENTITY_BINDING_TYPES) {
    const items = user[field] || [];
    const ops = [];

    for (const item of items) {
      if (!item) continue;
      const mismatch =
        item.clientName !== user.clientName ||
        item.userName !== user.userName ||
        item.userContact !== user.userContact;
      if (!mismatch) continue;

      ops.push({
        updateOne: {
          filter: { _id: item._id },
          update: { $set: { clientName: user.clientName, userName: user.userName, userContact: user.userContact } },
        },
      });
      fixed.push({ type: field, id: item._id });
    }

    if (ops.length) {
      await Model.collection.bulkWrite(ops, { ordered: false });
    }
  }

  return { fixed };
}
