import { open, seal, sha256Hex } from "./crypto.js";
import { assert, futureIso, parseCookies, randomToken, sessionCookie } from "./util.js";

export const SECRET_SETTINGS = new Set(["clicd_nodes_json", "hashpay_private_key"]);

export async function getSetting(env, key, fallback = "") {
  const row = await env.DB.prepare("SELECT value, encrypted FROM settings WHERE key = ?").bind(key).first();
  if (!row) return fallback;
  return row.encrypted ? open(row.value, env.MASTER_KEY) : row.value;
}

export async function getSettings(env, keys) {
  const result = {};
  for (const key of keys) result[key] = await getSetting(env, key, "");
  return result;
}

export async function setSettings(env, values) {
  const statements = [];
  for (const [key, raw] of Object.entries(values)) {
    const encrypted = SECRET_SETTINGS.has(key);
    const value = encrypted ? await seal(String(raw || ""), env.MASTER_KEY) : String(raw || "");
    statements.push(env.DB.prepare("INSERT INTO settings(key, value, encrypted, updated_at) VALUES(?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, encrypted = excluded.encrypted, updated_at = CURRENT_TIMESTAMP").bind(key, value, encrypted ? 1 : 0));
  }
  if (statements.length) await env.DB.batch(statements);
}

export async function createSession(env, userId) {
  const token = randomToken(32);
  const tokenHash = await sha256Hex(token);
  const csrf = randomToken(24);
  const days = Math.max(1, Math.min(30, Number.parseInt(env.SESSION_TTL_DAYS || "14", 10)));
  const expiresAt = futureIso(days * 86_400_000);
  await env.DB.prepare("INSERT INTO sessions(id, token_hash, user_id, csrf_token, expires_at) VALUES(?, ?, ?, ?, ?)")
    .bind(randomToken(16), tokenHash, userId, csrf, expiresAt).run();
  return { token, csrf, expiresAt, cookie: sessionCookie(token, days * 86_400, env.COOKIE_SAME_SITE || "Lax") };
}

export async function sessionUser(request, env) {
  const token = parseCookies(request).vps_session;
  if (!token) return null;
  const tokenHash = await sha256Hex(token);
  return env.DB.prepare(`SELECT u.id, u.username, u.email, u.is_admin, u.is_active, s.csrf_token, s.expires_at, s.token_hash
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > CURRENT_TIMESTAMP AND u.is_active = 1`).bind(tokenHash).first();
}

export async function requireUser(request, env, admin = false) {
  const user = await sessionUser(request, env);
  assert(user, 401, "authentication_required", "Sign in is required");
  if (admin) assert(user.is_admin === 1, 403, "administrator_required", "Administrator access is required");
  return user;
}

export function requireCsrf(request, user) {
  assert(request.headers.get("X-CSRF-Token") === user.csrf_token, 403, "invalid_csrf", "CSRF token is invalid");
}

export async function deleteSession(request, env) {
  const token = parseCookies(request).vps_session;
  if (token) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(await sha256Hex(token)).run();
  return sessionCookie("", 0, env.COOKIE_SAME_SITE || "Lax");
}

export async function ensureWallet(env, userId, currency = "CNY") {
  await env.DB.prepare("INSERT OR IGNORE INTO wallets(user_id, currency) VALUES(?, ?)").bind(userId, currency).run();
  return env.DB.prepare("SELECT * FROM wallets WHERE user_id = ?").bind(userId).first();
}

export async function audit(env, userId, action, detail, ip = "") {
  await env.DB.prepare("INSERT INTO audit_logs(user_id, action, detail, ip) VALUES(?, ?, ?, ?)").bind(userId || null, action, String(detail || "").slice(0, 4000), ip).run();
}

export async function cleanupExpired(env) {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM sessions WHERE expires_at <= CURRENT_TIMESTAMP"),
    env.DB.prepare("DELETE FROM vnc_sessions WHERE expires_at <= CURRENT_TIMESTAMP"),
    env.DB.prepare("DELETE FROM rate_limits WHERE expires_at <= CURRENT_TIMESTAMP"),
  ]);
}

export async function rateLimit(env, key, maximum, windowSeconds) {
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const expiresAt = new Date((bucket + 2) * windowSeconds * 1000).toISOString();
  const row = await env.DB.prepare(`INSERT INTO rate_limits(key, bucket, count, expires_at) VALUES(?, ?, 1, ?)
    ON CONFLICT(key, bucket) DO UPDATE SET count = count + 1 RETURNING count`).bind(key, bucket, expiresAt).first();
  assert(Number(row?.count || 0) <= maximum, 429, "rate_limit_exceeded", "Too many requests; try again later");
}
