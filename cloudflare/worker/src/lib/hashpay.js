import { decryptHashPayEnvelope, rsaSignBase64 } from "./crypto.js";
import { getSettings } from "./db.js";
import { assert } from "./util.js";

export async function hashPaySettings(env) {
  const values = await getSettings(env, ["site_url", "hashpay_base_url", "hashpay_merchant_id", "hashpay_private_key"]);
  values.hashpay_base_url = values.hashpay_base_url.replace(/\/+$/, "");
  return values;
}

export async function hashPayRequest(env, method, path, payload) {
  const settings = await hashPaySettings(env);
  assert(settings.hashpay_base_url && settings.hashpay_merchant_id && settings.hashpay_private_key, 503, "hashpay_not_configured", "HashPay is not configured");
  const body = payload === undefined ? "" : JSON.stringify(payload);
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = await rsaSignBase64(settings.hashpay_private_key, `${method}\n${path}\n${timestamp}\n${body}`);
  const response = await fetch(`${settings.hashpay_base_url}${path}`, {
    method,
    headers: { "X-Merchant-Id": settings.hashpay_merchant_id, "X-Timestamp": timestamp, "X-Signature": signature, "Content-Type": "application/json" },
    body: body || undefined,
  });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`HashPay request failed (${response.status}): ${JSON.stringify(result).slice(0, 600)}`);
  return result;
}

export async function createCheckout(env, referenceNo, amountCents, currency, description, returnPath) {
  const settings = await hashPaySettings(env);
  const payload = {
    merchantNo: referenceNo,
    amount: (amountCents / 100).toFixed(2),
    currency,
    description,
    notifyUrl: `${settings.site_url.replace(/\/+$/, "")}/api/payments/hashpay/callback`,
    returnUrl: `${settings.site_url.replace(/\/+$/, "")}${returnPath}`,
  };
  const result = await hashPayRequest(env, "POST", "/api/merchant/new", payload);
  const data = result.data || result;
  const checkoutUrl = String(data.checkoutUrl || data.payUrl || data.url || "");
  assert(checkoutUrl, 502, "hashpay_invalid_response", "HashPay did not return a checkout URL");
  return { checkoutUrl, id: String(data.id || data.orderId || "") || null };
}

export async function decodeCallback(env, request, envelope) {
  const settings = await hashPaySettings(env);
  assert(request.headers.get("X-HashPay-Merchant") === settings.hashpay_merchant_id, 401, "hashpay_merchant_mismatch", "HashPay merchant does not match");
  return decryptHashPayEnvelope(envelope, settings.hashpay_private_key);
}
