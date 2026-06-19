(function () {
  // DOM Elements
  const dom = {
    hardwareBtn: document.querySelector(".hardware"),
    softwareBtn: document.querySelector(".software"),
    hardwareOpt: document.querySelector(".hardware-options"),
    softwareOpt: document.querySelector(".software-options"),
    clientSwitch: document.querySelector(".client-switch"),
    userSwitch: document.querySelector(".user-switch"),
    clientContent: document.querySelector(".client-content"),
    userContent: document.querySelector(".user-content"),
    clientAccountHeadSelect: document.getElementById("account-head"),
    transportContact: document.querySelector("#transport-contact"),
    ownerMobNo: document.querySelector("#owner-mob-no"),
    clientNameSelect: document.getElementById("userform-client-name"),
    userContactNo: document.querySelector("#user-contact-no"),
    locationCountInput: document.getElementById("locations-count"),
    locationContainer: document.getElementById("locations-details"),
    locationMinusBtn: document.getElementById("locations-minus"),
    locationPlusBtn: document.getElementById("locations-plus"),
  };

  // Initialize Choices only once
  let choicesInstance = null;
  let accountHeadChoices = null;
  let isHandlingChange = false; // Guard against multiple triggers

  // Function to toggle disabled state based on visibility
  function updateInputDisabledState() {
    // Hardware options section
    const isHardwareVisible = window.getComputedStyle(dom.hardwareOpt).display !== "none";
    const hardwareInputs = dom.hardwareOpt.querySelectorAll("input, select");

    hardwareInputs.forEach((input) => {
      input.disabled = !isHardwareVisible;
      input.required = isHardwareVisible;
    });

    // Software options section
    const isSoftwareVisible = window.getComputedStyle(dom.softwareOpt).display !== "none";
    const softwareInputs = dom.softwareOpt.querySelectorAll("input, select");

    softwareInputs.forEach((input) => {
      input.disabled = !isSoftwareVisible;
      input.required = isSoftwareVisible;
    });
  }

  // Initialize the page
  function init() {
    if (!dom.hardwareBtn || !dom.softwareBtn) return;

    // Tab switching
    dom.hardwareBtn.addEventListener("click", () => toggleTabs("hardware"));
    dom.softwareBtn.addEventListener("click", () => toggleTabs("software"));

    // View switching
    if (dom.clientSwitch && dom.userSwitch) {
      dom.clientSwitch.addEventListener("click", () => toggleViews("client"));
      dom.userSwitch.addEventListener("click", () => toggleViews("user"));
    }

    // Format mobile inputs
    if (dom.transportContact) formatMobileInput(dom.transportContact);
    if (dom.ownerMobNo) formatMobileInput(dom.ownerMobNo);
    if (dom.userContactNo) formatMobileInput(dom.userContactNo);

    // Initialize Choices
    if (dom.clientNameSelect) {
      initChoicesSelect();
    }
    if (dom.clientAccountHeadSelect) {
      initAccountHeadChoices();
    }
    if (dom.locationCountInput && dom.locationContainer) {
      initLocationRepeater();
    }

    const gstInput = document.getElementById("client-gst");
    const panInput = document.getElementById("client-pan");

    if (gstInput) {
      gstInput.addEventListener("input", function () {
        const gst = this.value.toUpperCase();
        this.value = gst;

        if (gst.length >= 12) {
          const pan = gst.substring(2, 12);
          if (panInput) {
            panInput.value = pan;
            panInput.dispatchEvent(new Event("input"));
          }
        } else if (panInput) {
          panInput.value = "";
          panInput.dispatchEvent(new Event("input"));
        }

        const gstRegex = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
        if (gst.length > 0 && !gstRegex.test(gst)) {
          this.setCustomValidity("Invalid GST format (e.g., 22AAAAA0000A1Z5)");
        } else {
          this.setCustomValidity("");
        }
      });
    }

    if (panInput) {
      panInput.addEventListener("input", function () {
        const pan = this.value.toUpperCase();
        this.value = pan;
        const panRegex = /^[A-Z]{5}[0-9]{4}[A-Z]{1}$/;
        if (pan.length > 0 && !panRegex.test(pan)) {
          this.setCustomValidity("Invalid PAN format (e.g., ABCDE1234F)");
        } else {
          this.setCustomValidity("");
        }
      });
    }

    // Set up MutationObserver to watch for display changes
    const observer = new MutationObserver(function (mutations) {
      mutations.forEach(function (mutation) {
        if (mutation.attributeName === "style") {
          updateInputDisabledState();
        }
      });
    });

    // Observe both sections for style changes
    observer.observe(dom.hardwareOpt, { attributes: true });
    observer.observe(dom.softwareOpt, { attributes: true });

    // Initial state update
    updateInputDisabledState();

    // Handle URL query parameter for tab switching
    const urlParams = new URLSearchParams(window.location.search);
    const tabParam = urlParams.get("tab");
    const clientNameParam = urlParams.get("clientName");

    if (tabParam === "user" && dom.userSwitch) {
      toggleViews("user");
      if (clientNameParam && dom.clientNameSelect) {
        if (choicesInstance) {
          choicesInstance.setChoiceByValue(clientNameParam);
        } else {
          dom.clientNameSelect.value = clientNameParam;
        }
        handleClientChange(clientNameParam);
      }
    } else if (tabParam === "client" && dom.clientSwitch) {
      toggleViews("client");
    }
  }

  function toggleTabs(activeTab) {
    const isHardware = activeTab === "hardware";
    dom.hardwareBtn.classList.toggle("active", isHardware);
    dom.softwareBtn.classList.toggle("active", !isHardware);
    dom.hardwareOpt.style.display = isHardware ? "grid" : "none";
    dom.softwareOpt.style.display = isHardware ? "none" : "grid";

    // Update disabled states after visibility changes
    updateInputDisabledState();
  }

  function toggleViews(activeView) {
    const isClient = activeView === "client";
    dom.clientSwitch.classList.toggle("active", isClient);
    dom.userSwitch.classList.toggle("active", !isClient);
    dom.clientContent.style.display = isClient ? "grid" : "none";
    dom.userContent.style.display = isClient ? "none" : "grid";

    if (!isClient) {
      dom.userContent.style.gridTemplateColumns = "repeat(32, 1fr)";
      dom.userContent.style.gap = "1.25rem";
    }
  }

  function formatMobileInput(input) {
    input.addEventListener("keydown", (e) => {
      const allowedKeys = ["Backspace", "ArrowLeft", "ArrowRight", "Tab", "Delete"];

      // Allow Ctrl+V / Cmd+V
      if ((e.ctrlKey || e.metaKey) && ["v", "V", "c", "C", "x", "X", "a", "A"].includes(e.key)) {
        return; // allow paste, copy, cut, select all
      }

      if (!/^\d$/.test(e.key) && !allowedKeys.includes(e.key)) {
        e.preventDefault();
      }
    });

    input.addEventListener("input", function () {
      let digits = this.value.replace(/\D/g, "").slice(0, 10);
      this.value = digits.length > 5 ? `${digits.slice(0, 5)} ${digits.slice(5)}` : digits;
    });
  }

  function initChoicesSelect() {
    try {
      choicesInstance = new Choices(dom.clientNameSelect, {
        searchEnabled: true,
        itemSelectText: "",
        shouldSort: false,
        callbackOnInit: function () {
          // Add ONE event listener after initialization
          this.passedElement.element.addEventListener("change", (e) => {
            if (isHandlingChange) return;
            isHandlingChange = true;

            setTimeout(() => {
              isHandlingChange = false;
            }, 100);

            handleClientChange(e.target.value);
          });
        },
      });
    } catch (e) {
      console.error("Choices initialization failed:", e);
      // Fallback to native select
      dom.clientNameSelect.addEventListener("change", (e) => {
        handleClientChange(e.target.value);
      });
    }
  }

  function initAccountHeadChoices() {
    try {
      accountHeadChoices = new Choices(dom.clientAccountHeadSelect, {
        searchEnabled: true,
        itemSelectText: "",
        shouldSort: false,
      });
    } catch (e) {
      console.error("Account head Choices initialization failed:", e);
    }
  }

  function normalizeLocationCount(value) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed < 1) return 1;
    return Math.min(parsed, 25);
  }

  function setLocationCount(value) {
    if (!dom.locationCountInput || !dom.locationContainer) return;
    const safeCount = normalizeLocationCount(value);
    dom.locationCountInput.value = String(safeCount);
    renderLocationRows(safeCount);
  }

  function renderLocationRows(count) {
    if (!dom.locationContainer) return;

    const safeCount = normalizeLocationCount(count);
    const existingRows = Array.from(dom.locationContainer.querySelectorAll(".location-row"));
    const currentValues = existingRows.map((row) => {
      const inputs = row.querySelectorAll("input");
      return {
        userLocation: inputs[0]?.value || "",
        dispatchAddress: inputs[1]?.value || "",
      };
    });

    dom.locationContainer.innerHTML = "";

    for (let i = 0; i < safeCount; i += 1) {
      const values = currentValues[i] || { userLocation: "", dispatchAddress: "" };
      dom.locationContainer.insertAdjacentHTML(
        "beforeend",
        `
          <div class="location-row">
            <input
              type="text"
              class="form-control input-tag"
              name="locationDetails[${i}][userLocation]"
              placeholder="Enter Location"
              aria-label="Location ${i + 1}"
              value="${escapeAttr(values.userLocation.toUpperCase())}"
              oninput="this.value = this.value.toUpperCase()"
              required
            />
            <input
              type="text"
              class="form-control input-tag"
              name="locationDetails[${i}][dispatchAddress]"
              placeholder="Enter Address"
              aria-label="Address ${i + 1}"
              value="${escapeAttr(values.dispatchAddress.toUpperCase())}"
              oninput="this.value = this.value.toUpperCase()"
              required
            />
          </div>
        `,
      );
    }
  }

  function initLocationRepeater() {
    setLocationCount(dom.locationCountInput.value || 1);

    dom.locationMinusBtn?.addEventListener("click", () => {
      const current = normalizeLocationCount(dom.locationCountInput.value || 1);
      setLocationCount(Math.max(1, current - 1));
    });

    dom.locationPlusBtn?.addEventListener("click", () => {
      const current = normalizeLocationCount(dom.locationCountInput.value || 1);
      setLocationCount(Math.min(25, current + 1));
    });
  }

  function escapeAttr(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  function handleClientChange(clientName) {
    if (!clientName) return;

    console.log("Client changed (triggered once):", clientName);

    fetch(`/fairdesk/form/client/${encodeURIComponent(clientName)}`)
      .then((response) => response.json())
      .then((data) => {
        console.log("Response:", data);
        feedClientData(data);
      })
      .catch((error) => console.error("Error:", error));
  }

  // Start when DOM is ready
  if (document.readyState !== "loading") {
    init();
  } else {
    document.addEventListener("DOMContentLoaded", init);
  }
})();

function feedClientData(data) {
  console.log(data._id);
  document.getElementById("user-client-id").value = data.clientId;
  document.getElementById("username-client-type").value = data.clientType;
  document.getElementById("username-client-type-hidden").value = data.clientType || "";
  document.getElementById("username-ho-location").value = data.hoLocation;
  document.getElementById("username-account-head").value = data.accountHead;
  document.getElementById("object-id").value = data._id;
}
