// Location-details repeater for the vendor coordinator forms (the New Vendor
// dialog's Coordinator tab, views/users/_vendorForm.ejs, and the Edit
// Coordinator page, views/users/editVendorUser.ejs). Markup matches
// views/users/_vendorLocationRow.ejs; the .location-row / .loc-* classes are
// the hooks. Usage:
//   const rep = initVendorLocationRepeater({ countInput, container, minusBtn, plusBtn });
//   rep.setCount(1);
// Also exposes window.formatVendorMobileValue / formatVendorMobileInput.
(function () {
  "use strict";

  const MAX = 20;
  const EMPTY_ROW = {
    userLocation: "", dispatchAddress: "", selfDispatch: "", transportName: "", transportContact: "",
    dropLocation: "", dropLocation1: "", deliveryMode: "", deliveryLocation: "", deliveryLocation1: "", vendorPayment: "",
  };

  function formatMobileValue(value) {
    const digits = String(value ?? "").replace(/\D/g, "").slice(0, 10);
    return digits.length > 5 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : digits;
  }

  function formatMobileInput(input) {
    input.addEventListener("keydown", (e) => {
      const allowedKeys = ["Backspace", "ArrowLeft", "ArrowRight", "Tab", "Delete"];
      if ((e.ctrlKey || e.metaKey) && ["v", "V", "c", "C", "x", "X", "a", "A"].includes(e.key)) return;
      if (!/^\d$/.test(e.key) && !allowedKeys.includes(e.key)) e.preventDefault();
    });
    input.addEventListener("input", function () {
      this.value = formatMobileValue(this.value);
    });
  }

  function normalizeCount(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return 1;
    return Math.min(parsed, MAX);
  }

  function escapeAttr(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/'/g, "&#39;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function readRowValues(row) {
    const out = {};
    Object.keys(EMPTY_ROW).forEach((k) => {
      out[k] = row.querySelector(`[name$="[${k}]"]`)?.value || "";
    });
    return out;
  }

  function buildRowHtml(i, v) {
    const isSelf = v.selfDispatch === "Self Dispatch";
    const sel = (val, opt) => (val === opt ? "selected" : "");
    return `
      <div class="location-row">
        <div class="loc-line">
          <input type="text" name="locationDetails[${i}][userLocation]"
            placeholder="Enter Location" aria-label="Location ${i + 1}"
            value="${escapeAttr(v.userLocation.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" required />
          <input type="text" name="locationDetails[${i}][dispatchAddress]"
            placeholder="Enter Address" aria-label="Address ${i + 1}"
            value="${escapeAttr(v.dispatchAddress.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" required />
        </div>
        <div class="loc-dispatch">
          <span class="loc-title">Pick Up Details — Location ${i + 1}</span>
          <div class="loc-fields">
            <select class="loc-dispatch-mode" aria-label="Pick Up Type for location ${i + 1}">
              <option value="TRANSPORT" ${isSelf ? "" : "selected"}>Transport</option>
              <option value="SELF" ${isSelf ? "selected" : ""}>Self Pick Up</option>
            </select>
            <input type="hidden" class="loc-self-dispatch" name="locationDetails[${i}][selfDispatch]" value="${isSelf ? "Self Dispatch" : ""}" />
            <div class="loc-transport" style="${isSelf ? "display:none;" : ""}">
              <input type="text" name="locationDetails[${i}][transportName]"
                placeholder="Transport Name" value="${escapeAttr(v.transportName.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" />
              <input type="text" class="loc-transport-contact" name="locationDetails[${i}][transportContact]"
                placeholder="Transport Contact" value="${escapeAttr(v.transportContact)}" />
              <input type="text" name="locationDetails[${i}][dropLocation]"
                placeholder="Drop Location 1" value="${escapeAttr(v.dropLocation.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" />
              <input type="text" name="locationDetails[${i}][dropLocation1]"
                placeholder="Drop Location 2" value="${escapeAttr(v.dropLocation1.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" />
              <select name="locationDetails[${i}][deliveryMode]">
                <option value="">Pick Up Mode</option>
                <option value="DOOR" ${sel(v.deliveryMode, "DOOR")}>DOOR</option>
                <option value="GODOWN" ${sel(v.deliveryMode, "GODOWN")}>GODOWN</option>
              </select>
              <input type="text" name="locationDetails[${i}][deliveryLocation]"
                placeholder="Pick Up Loc" value="${escapeAttr(v.deliveryLocation.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" />
              <input type="text" name="locationDetails[${i}][deliveryLocation1]"
                placeholder="Pick Up Loc 1" value="${escapeAttr(v.deliveryLocation1.toUpperCase())}" oninput="this.value = this.value.toUpperCase()" />
              <select name="locationDetails[${i}][vendorPayment]">
                <option value="">Payment</option>
                <option value="PAY" ${sel(v.vendorPayment, "PAY")}>PAY</option>
                <option value="TO PAY" ${sel(v.vendorPayment, "TO PAY")}>TO PAY</option>
                <option value="NA" ${sel(v.vendorPayment, "NA")}>NA</option>
              </select>
            </div>
            <div class="loc-self" style="${isSelf ? "" : "display:none;"}">
              <span class="loc-self-badge">Self Pick Up</span>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function applyDispatchMode(row, mode) {
    if (!row) return;
    const transport = row.querySelector(".loc-transport");
    const self = row.querySelector(".loc-self");
    const hidden = row.querySelector(".loc-self-dispatch");
    const isSelf = mode === "SELF";
    if (transport) transport.style.display = isSelf ? "none" : "";
    if (self) self.style.display = isSelf ? "" : "none";
    if (hidden) hidden.value = isSelf ? "Self Dispatch" : "";
  }

  window.formatVendorMobileValue = formatMobileValue;
  window.formatVendorMobileInput = formatMobileInput;

  window.initVendorLocationRepeater = function ({ countInput, container, minusBtn, plusBtn }) {
    if (!countInput || !container) return { setCount() {} };

    function render(count) {
      const current = Array.from(container.querySelectorAll(".location-row")).map(readRowValues);
      let html = "";
      for (let i = 0; i < count; i += 1) html += buildRowHtml(i, current[i] || { ...EMPTY_ROW });
      container.innerHTML = html;
    }

    function setCount(value) {
      const safe = normalizeCount(value);
      countInput.value = String(safe);
      render(safe);
    }

    minusBtn?.addEventListener("click", () => setCount(Math.max(1, normalizeCount(countInput.value) - 1)));
    plusBtn?.addEventListener("click", () => setCount(Math.min(MAX, normalizeCount(countInput.value) + 1)));

    // Delegated, so it survives every re-render.
    container.addEventListener("change", (e) => {
      const modeSel = e.target.closest(".loc-dispatch-mode");
      if (modeSel) applyDispatchMode(modeSel.closest(".location-row"), modeSel.value);
    });
    container.addEventListener("input", (e) => {
      const el = e.target.closest(".loc-transport-contact");
      if (el) el.value = formatMobileValue(el.value);
    });

    // Re-render so the count input and rows start in sync (values preserved).
    setCount(countInput.value || 1);
    return { setCount };
  };
})();
