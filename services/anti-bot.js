"use strict";

const BLOCKED_USER_AGENTS = [
  /sqlmap/i,
  /nikto/i,
  /masscan/i,
  /zgrab/i,
  /nmap scripting engine/i,
  /python-requests/i,
  /scrapy/i,
  /libwww-perl/i,
];

const requestBuckets = new Map();

const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 30;
const MAX_BUCKETS = 10000;

function getClientIp(req) {
  // Do not trust X-Forwarded-For unless your proxy is configured
  // and you explicitly validate its forwarded client IP.
  return req.socket.remoteAddress || "unknown";
}

function isBlockedUserAgent(userAgent) {
  if (typeof userAgent !== "string" || !userAgent.trim()) {
    return true;
  }

  return BLOCKED_USER_AGENTS.some((pattern) => pattern.test(userAgent));
}

function isRateLimited(ip) {
  const now = Date.now();
  const previous = requestBuckets.get(ip) || [];

  const recent = previous.filter((timestamp) => now - timestamp < WINDOW_MS);

  if (recent.length >= MAX_REQUESTS_PER_WINDOW) {
    requestBuckets.set(ip, recent);
    return true;
  }

  recent.push(now);
  requestBuckets.set(ip, recent);

  if (requestBuckets.size > MAX_BUCKETS) {
    for (const [key, timestamps] of requestBuckets) {
      if (
        !timestamps.length ||
        now - timestamps[timestamps.length - 1] >= WINDOW_MS
      ) {
        requestBuckets.delete(key);
      }

      if (requestBuckets.size <= MAX_BUCKETS * 0.8) {
        break;
      }
    }
  }

  return false;
}

function inspect(req, options = {}) {
  const userAgent = req.headers["user-agent"] || "";
  const ip = getClientIp(req);

  if (options.checkUserAgent !== false && isBlockedUserAgent(userAgent)) {
    return {
      blocked: true,
      status: 403,
      reason: "blocked_user_agent",
    };
  }

  if (options.checkRateLimit !== false && isRateLimited(ip)) {
    return {
      blocked: true,
      status: 429,
      reason: "rate_limit",
    };
  }

  return {
    blocked: false,
    status: 200,
    reason: null,
  };
}

module.exports = {
  inspect,
  isBlockedUserAgent,
  getClientIp,
};
