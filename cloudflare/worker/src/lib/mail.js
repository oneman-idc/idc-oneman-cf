import { getSetting } from "./db.js";

export async function sendMail(env, recipient, subject, text, options = {}) {
  if (!env.RESEND_API_TOKEN) throw new Error("RESEND_API_TOKEN is not configured");
  const from = (await getSetting(env, "resend_from", "")) || env.EMAIL_FROM;
  if (!from) throw new Error("Email sender is not configured");
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(recipient || "").trim())) throw new Error("Email recipient is invalid");
  const endpoint = new URL(env.RESEND_API_URL || "https://api.resend.com/emails");
  if (endpoint.origin !== "https://api.resend.com" && env.ALLOW_CUSTOM_RESEND_ENDPOINTS !== "true") {
    throw new Error("Custom Resend API endpoints are disabled");
  }
  const idempotencyKey = String(options.idempotencyKey || crypto.randomUUID()).replace(/[^A-Za-z0-9:_-]/g, "-").slice(0, 200);
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.RESEND_API_TOKEN}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ from, to: [recipient], subject, text }),
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Email API failed (${response.status}): ${JSON.stringify(result).slice(0, 600)}`);
  return result;
}
