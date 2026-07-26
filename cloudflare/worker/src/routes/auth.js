import { equalText, hashPassword, verifyPassword } from "../lib/crypto.js";
import { createSession, deleteSession, ensureWallet, newSession, rateLimit, sessionUser } from "../lib/db.js";
import { assert, bodyJson, clientIp, HttpError, json, normalizeEmail, randomLetters } from "../lib/util.js";

function validPassword(value) {
  return typeof value === "string" && value.length >= 10 && value.length <= 200 && /[A-Za-z]/.test(value) && /\d/.test(value);
}

async function uniqueUsername(env) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    const value = randomLetters(6);
    if (!(await env.DB.prepare("SELECT 1 FROM users WHERE username = ?").bind(value).first())) return value;
  }
  throw new Error("Could not allocate a username");
}

function publicUser(user) {
  return user ? { id: user.id, username: user.username, email: user.email, is_admin: user.is_admin === 1 } : null;
}

export async function getSession(request, env) {
  const user = await sessionUser(request, env);
  return json({ ok: true, user: publicUser(user), csrf_token: user?.csrf_token || "" });
}

export async function bootstrap(request, env) {
  assert(env.ADMIN_BOOTSTRAP_TOKEN, 503, "bootstrap_token_missing", "ADMIN_BOOTSTRAP_TOKEN is not configured in the Worker");
  const authorization = request.headers.get("Authorization") || "";
  assert(equalText(authorization, `Bearer ${env.ADMIN_BOOTSTRAP_TOKEN}`), 401, "invalid_bootstrap_token", "Bootstrap authorization failed");
  await rateLimit(env, `bootstrap:${clientIp(request)}`, 5, 900);
  const count = await env.DB.prepare("SELECT COUNT(*) count FROM users").first();
  assert(Number(count?.count || 0) === 0, 409, "already_initialized", "The application is already initialized");
  const body = await bodyJson(request);
  const email = normalizeEmail(body.email);
  assert(email, 422, "invalid_email", "Enter a valid administrator email");
  assert(validPassword(body.password), 422, "weak_password", "Password must be 10-200 characters and contain letters and numbers");
  const username = await uniqueUsername(env);
  let passwordHash;
  try {
    passwordHash = await hashPassword(body.password, env.SECRET_KEY);
  } catch (error) {
    console.error("bootstrap password hashing failed", error);
    throw new HttpError(500, "bootstrap_password_hash_failed", "The Worker could not secure the administrator password");
  }
  const session = await newSession(env);
  try {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users(username, email, password_hash, is_admin) SELECT ?, ?, ?, 1 WHERE NOT EXISTS (SELECT 1 FROM users)").bind(username, email, passwordHash),
      env.DB.prepare("INSERT OR IGNORE INTO wallets(user_id, currency) SELECT id, 'CNY' FROM users WHERE email = ?").bind(email),
      env.DB.prepare("INSERT INTO sessions(id, token_hash, user_id, csrf_token, expires_at) SELECT ?, ?, id, ?, ? FROM users WHERE email = ?")
        .bind(session.id, session.tokenHash, session.csrf, session.expiresAt, email),
    ]);
  } catch (error) {
    console.error("bootstrap D1 transaction failed", error);
    throw new HttpError(500, "bootstrap_database_failed", "D1 could not create the administrator; verify the DB binding and retry");
  }
  const inserted = await env.DB.prepare("SELECT id, username, email, is_admin FROM users WHERE email = ?").bind(email).first();
  assert(inserted, 409, "already_initialized", "The application is already initialized");
  return json({ ok: true, user: publicUser(inserted), csrf_token: session.csrf }, 201, { "Set-Cookie": session.cookie });
}

export async function register(request, env) {
  await rateLimit(env, `register:${clientIp(request)}`, 10, 900);
  const users = await env.DB.prepare("SELECT COUNT(*) count FROM users").first();
  assert(Number(users?.count || 0) > 0, 503, "not_initialized", "Create the administrator account before opening registration");
  const body = await bodyJson(request);
  const email = normalizeEmail(body.email);
  assert(email, 422, "invalid_email", "Enter a valid email address");
  assert(validPassword(body.password), 422, "weak_password", "Password must be 10-200 characters and contain letters and numbers");
  assert(!(await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first()), 409, "email_exists", "This email is already registered");
  const username = await uniqueUsername(env);
  let user;
  try {
    user = await env.DB.prepare("INSERT INTO users(username, email, password_hash) VALUES(?, ?, ?) RETURNING id, username, email, is_admin")
      .bind(username, email, await hashPassword(body.password, env.SECRET_KEY)).first();
  } catch (error) {
    if (String(error).includes("UNIQUE")) return json({ ok: false, error: { code: "email_exists", message: "This email is already registered" } }, 409);
    throw error;
  }
  await ensureWallet(env, user.id);
  const session = await createSession(env, user.id);
  return json({ ok: true, user: publicUser(user), csrf_token: session.csrf }, 201, { "Set-Cookie": session.cookie });
}

export async function login(request, env) {
  await rateLimit(env, `login:${clientIp(request)}`, 15, 900);
  const body = await bodyJson(request);
  const email = normalizeEmail(body.email);
  const user = email ? await env.DB.prepare("SELECT * FROM users WHERE email = ? AND is_active = 1").bind(email).first() : null;
  assert(user && await verifyPassword(user.password_hash, String(body.password || ""), env.SECRET_KEY), 401, "invalid_credentials", "Email or password is incorrect");
  await env.DB.prepare("UPDATE users SET last_login_at = CURRENT_TIMESTAMP WHERE id = ?").bind(user.id).run();
  const session = await createSession(env, user.id);
  return json({ ok: true, user: publicUser(user), csrf_token: session.csrf }, 200, { "Set-Cookie": session.cookie });
}

export async function logout(request, env) {
  return json({ ok: true }, 200, { "Set-Cookie": await deleteSession(request, env) });
}
