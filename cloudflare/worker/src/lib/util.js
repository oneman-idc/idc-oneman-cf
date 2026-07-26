const encoder = new TextEncoder();

export function bytes(value) {
  return typeof value === "string" ? encoder.encode(value) : value;
}

export function base64Url(value) {
  const data = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const item of data) binary += String.fromCharCode(item);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

export function fromBase64Url(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(normalized);
  return Uint8Array.from(binary, (item) => item.charCodeAt(0));
}

export function randomToken(size = 32) {
  return base64Url(crypto.getRandomValues(new Uint8Array(size)));
}

export function randomCode(length = 6) {
  const data = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(data, (value) => String(value % 10)).join("");
}

export function randomLetters(length = 6) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const data = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(data, (value) => alphabet[value % alphabet.length]).join("");
}

export function nowIso() {
  return new Date().toISOString();
}

export function futureIso(milliseconds) {
  return new Date(Date.now() + milliseconds).toISOString();
}

export function reference(prefix) {
  return `${prefix}${Date.now().toString(36).toUpperCase()}${randomToken(6).toUpperCase()}`.replace(/[-_]/g, "").slice(0, 40);
}

export function parseCookies(request) {
  const result = {};
  for (const pair of (request.headers.get("Cookie") || "").split(";")) {
    const index = pair.indexOf("=");
    if (index > 0) result[pair.slice(0, index).trim()] = decodeURIComponent(pair.slice(index + 1).trim());
  }
  return result;
}

export function sessionCookie(value, maxAge = 0, sameSite = "Lax") {
  const age = maxAge > 0 ? `; Max-Age=${Math.floor(maxAge)}` : "; Max-Age=0";
  const policy = new Set(["Lax", "Strict", "None"]).has(sameSite) ? sameSite : "Lax";
  return `vps_session=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=${policy}${age}`;
}

export function securityHeaders(extra = {}) {
  return {
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Referrer-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    ...extra,
  };
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: securityHeaders({ "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", ...headers }),
  });
}

export function fail(status, code, message, details) {
  return json({ ok: false, error: { code, message, ...(details ? { details } : {}) } }, status);
}

export async function bodyJson(request, maxBytes = 256_000) {
  const length = Number(request.headers.get("Content-Length") || 0);
  if (length > maxBytes) throw new HttpError(413, "payload_too_large", "Request body is too large");
  let raw;
  try {
    raw = await request.text();
  } catch {
    throw new HttpError(400, "invalid_body", "Could not read request body");
  }
  if (raw.length > maxBytes) throw new HttpError(413, "payload_too_large", "Request body is too large");
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON");
  }
}

export class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function assert(condition, status, code, message, details) {
  if (!condition) throw new HttpError(status, code, message, details);
}

export function asInt(value, fallback = 0, minimum = Number.MIN_SAFE_INTEGER, maximum = Number.MAX_SAFE_INTEGER) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.max(minimum, Math.min(maximum, parsed)) : fallback;
}

export function normalizeEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 190 ? email : "";
}

export function clientIp(request) {
  return request.headers.get("CF-Connecting-IP") || "";
}

export function route(pathname, pattern) {
  const match = pathname.match(pattern);
  return match ? match.slice(1).map(decodeURIComponent) : null;
}
