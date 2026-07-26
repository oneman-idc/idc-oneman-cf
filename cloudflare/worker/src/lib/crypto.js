import { base64Url, bytes, fromBase64Url, randomToken } from "./util.js";

export async function sha256(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes(value)));
}

export async function sha256Hex(value) {
  return Array.from(await sha256(value), (item) => item.toString(16).padStart(2, "0")).join("");
}

export async function hmacHex(secret, value) {
  const key = await crypto.subtle.importKey("raw", bytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, bytes(value));
  return Array.from(new Uint8Array(signature), (item) => item.toString(16).padStart(2, "0")).join("");
}

export function equalText(left, right) {
  const a = String(left || "");
  const b = String(right || "");
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) mismatch |= (a.charCodeAt(index % Math.max(a.length, 1)) || 0) ^ (b.charCodeAt(index % Math.max(b.length, 1)) || 0);
  return mismatch === 0;
}

export async function hashPassword(password, secretKey) {
  const salt = randomToken(16);
  const iterations = 210_000;
  const material = await crypto.subtle.importKey("raw", bytes(`${password}\0${secretKey}`), "PBKDF2", false, ["deriveBits"]);
  const result = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64Url(salt), iterations }, material, 256);
  return `pbkdf2_sha256_peppered$${iterations}$${salt}$${base64Url(result)}`;
}

export async function verifyPassword(encoded, password, secretKey) {
  const parts = String(encoded || "").split("$");
  if (parts[0] === "hmac_sha256" && parts.length === 3 && parts[1] && parts[2]) {
    return equalText(await hmacHex(secretKey, `password:v1:${parts[1]}:${password}`), parts[2]);
  }
  const [algorithm, rounds, saltText, expected] = parts;
  const iterations = Number(rounds);
  if (!new Set(["pbkdf2_sha256", "pbkdf2_sha256_peppered"]).has(algorithm) || !Number.isInteger(iterations) || iterations < 100_000 || !saltText || !expected) return false;
  const input = algorithm === "pbkdf2_sha256_peppered" ? `${password}\0${secretKey}` : password;
  const material = await crypto.subtle.importKey("raw", bytes(input), "PBKDF2", false, ["deriveBits"]);
  const result = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64Url(saltText), iterations }, material, 256);
  return equalText(base64Url(result), expected);
}

async function aesKey(masterKey) {
  return crypto.subtle.importKey("raw", await sha256(masterKey), { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function seal(value, masterKey) {
  if (!value) return "";
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await aesKey(masterKey), bytes(String(value)));
  return `v1.${base64Url(iv)}.${base64Url(ciphertext)}`;
}

export async function open(sealed, masterKey) {
  if (!sealed) return "";
  const [version, iv, ciphertext] = String(sealed).split(".");
  if (version !== "v1" || !iv || !ciphertext) throw new Error("Unsupported encrypted value");
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64Url(iv) }, await aesKey(masterKey), fromBase64Url(ciphertext));
  return new TextDecoder().decode(plaintext);
}

export async function fingerprint(value, secretKey) {
  return hmacHex(secretKey, value);
}

export async function confirmationHash(purpose, code, secretKey) {
  return hmacHex(secretKey, `${purpose}:${code}`);
}

function pemBytes(pem) {
  const body = String(pem || "").replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s/g, "");
  if (!body) throw new Error("RSA private key is not configured");
  return Uint8Array.from(atob(body), (item) => item.charCodeAt(0));
}

export async function rsaSignBase64(privatePem, message) {
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(privatePem), { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
  const signed = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, bytes(message)));
  let binary = "";
  for (const item of signed) binary += String.fromCharCode(item);
  return btoa(binary);
}

export async function decryptHashPayEnvelope(envelope, privatePem) {
  if (envelope?.alg !== "RSA-OAEP-256+A256GCM") throw new Error("Unsupported HashPay callback algorithm");
  const key = await crypto.subtle.importKey("pkcs8", pemBytes(privatePem), { name: "RSA-OAEP", hash: "SHA-256" }, false, ["decrypt"]);
  const aesRaw = await crypto.subtle.decrypt({ name: "RSA-OAEP" }, key, Uint8Array.from(atob(envelope.key), (item) => item.charCodeAt(0)));
  const aes = await crypto.subtle.importKey("raw", aesRaw, { name: "AES-GCM" }, false, ["decrypt"]);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: Uint8Array.from(atob(envelope.iv), (item) => item.charCodeAt(0)) },
    aes,
    Uint8Array.from(atob(envelope.data), (item) => item.charCodeAt(0)),
  );
  const message = JSON.parse(new TextDecoder().decode(plaintext));
  if (Math.abs(Date.now() / 1000 - Number(message.timestamp || 0)) > 300) throw new Error("HashPay callback expired");
  if (!message.payload || typeof message.payload !== "object") throw new Error("Invalid HashPay callback payload");
  return message.payload;
}

export function opaqueId() {
  return randomToken(18);
}
