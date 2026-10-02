// Styled file-upload field — public/css/salesOrderForm.css (.so-upload).
// The <input type="file"> stays in the markup, full-size and focusable, just
// painted invisible (opacity: 0) and sitting on top — so a click or a
// keyboard Enter/Space on the control opens the native file dialog exactly
// as it would on a bare input. This script only reflects the input's state
// onto the label (icon + chosen filename) and runs the × (clear) button,
// which a bare <input type="file"> has no way to do.
//
// Markup (see formStyle.md, "File upload — so-upload"):
//   <div class="so-upload" data-so-upload data-icon="fa-solid fa-file-image" data-placeholder="Choose JPG file">
//     <input type="file" class="so-upload__input" ... />
//     <div class="so-upload__control">
//       <span class="so-upload__icon"><i class="fa-solid fa-cloud-arrow-up"></i></span>
//       <span class="so-upload__text">Choose JPG file</span>
//     </div>
//     <button type="button" class="so-upload__clear" hidden tabindex="-1" title="Remove file"><i class="fa-solid fa-xmark"></i></button>
//   </div>
//
// `data-icon` (optional): the icon class swapped in once a file is picked
// (defaults to a generic file icon). `data-placeholder` (optional): the
// label text shown with nothing picked (defaults to "Choose file").
//
// Safe to call more than once (each field is bound once) and safe to call on
// content added after page load (a dialog opened later, a repeated block) —
// call `window.soUpload.init(container)` on that container once it's in the DOM.
(function () {
  "use strict";

  const DEFAULT_EMPTY_ICON = "fa-solid fa-cloud-arrow-up";
  const DEFAULT_FILLED_ICON = "fa-solid fa-file";
  const DEFAULT_PLACEHOLDER = "Choose file";

  function applyState(field) {
    const input = field.querySelector(".so-upload__input");
    const text = field.querySelector(".so-upload__text");
    const icon = field.querySelector(".so-upload__icon i");
    const clearBtn = field.querySelector(".so-upload__clear");
    const file = input && input.files && input.files[0];

    if (file) {
      field.classList.add("so-upload--filled");
      if (text) {
        text.textContent = file.name;
        text.title = file.name;
      }
      if (icon) icon.className = field.dataset.icon || DEFAULT_FILLED_ICON;
      if (clearBtn) clearBtn.hidden = false;
    } else {
      field.classList.remove("so-upload--filled");
      if (text) {
        text.textContent = field.dataset.placeholder || DEFAULT_PLACEHOLDER;
        text.removeAttribute("title");
      }
      if (icon) icon.className = field.dataset.emptyIcon || DEFAULT_EMPTY_ICON;
      if (clearBtn) clearBtn.hidden = true;
    }
  }

  function bind(field) {
    if (field.dataset.soUploadBound) return;
    field.dataset.soUploadBound = "1";

    const input = field.querySelector(".so-upload__input");
    const clearBtn = field.querySelector(".so-upload__clear");
    if (!input) return;

    input.addEventListener("change", () => applyState(field));

    if (clearBtn) {
      clearBtn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        input.value = "";
        applyState(field);
      });
    }

    applyState(field);
  }

  function init(root) {
    (root || document).querySelectorAll("[data-so-upload]").forEach(bind);
  }

  document.addEventListener("DOMContentLoaded", () => init());

  // A native form.reset() (soDialog.open()'s form.reset(), or a page calling
  // it directly before opening a dialog, e.g. the Common form's reset before
  // soDialog.open on the New Color Label dialog) clears the real <input
  // type="file">'s value but fires no "change" event on it -- so without
  // this, a field stays showing the old filename after the form it's in gets
  // reset. The "reset" event bubbles and fires after the fields are actually
  // cleared, so re-reading them here is safe.
  document.addEventListener(
    "reset",
    (e) => {
      if (e.target instanceof HTMLFormElement) init(e.target);
    },
    true,
  );

  window.soUpload = { init };
})();
