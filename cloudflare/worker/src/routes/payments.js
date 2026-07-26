import { sha256Hex } from "../lib/crypto.js";
import { ensureWallet, rateLimit } from "../lib/db.js";
import { decodeCallback } from "../lib/hashpay.js";
import { enqueueJob } from "../lib/jobs.js";
import { assert, bodyJson, clientIp, json, reference } from "../lib/util.js";

function paymentCents(value) {
  const text = String(value ?? "").trim();
  assert(/^\d+(?:\.\d{1,2})?$/.test(text), 400, "invalid_payment_amount", "Payment amount format is invalid");
  return Math.round(Number(text) * 100);
}

export async function hashPayCallback(request, env) {
  await rateLimit(env, `hashpay:${clientIp(request)}`, 120, 60);
  const envelope = await bodyJson(request, 512_000);
  let payload;
  try {
    payload = await decodeCallback(env, request, envelope);
  } catch (error) {
    assert(false, 400, "hashpay_callback_invalid", "HashPay callback validation failed", String(error.message || error));
  }
  const referenceNo = String(payload.merchantNo || "");
  const order = referenceNo ? await env.DB.prepare("SELECT * FROM orders WHERE order_no = ?").bind(referenceNo).first() : null;
  const topup = !order && referenceNo ? await env.DB.prepare("SELECT * FROM wallet_topups WHERE topup_no = ?").bind(referenceNo).first() : null;
  const target = order || topup;
  assert(target, 404, "payment_reference_not_found", "Payment reference was not found");
  const eventId = String(payload.eventId || payload.id || await sha256Hex(JSON.stringify(payload)));
  if (await env.DB.prepare("SELECT 1 FROM payment_events WHERE event_id = ?").bind(eventId).first()) return json({ ok: true, duplicate: true });
  const paidStatus = new Set(["paid", "success", "completed"]).has(String(payload.status || "").toLowerCase());
  const amountMatches = paymentCents(payload.amount) === target.amount_cents;
  const currencyMatches = String(payload.currency || target.currency).toUpperCase() === String(target.currency).toUpperCase();
  const verified = paidStatus && amountMatches && currencyMatches;
  await env.DB.prepare("INSERT INTO payment_events(event_id, reference_no, platform_txn_id, verified, payload) VALUES(?, ?, ?, ?, ?)")
    .bind(eventId, referenceNo, String(payload.transactionId || ""), verified ? 1 : 0, JSON.stringify(payload)).run();
  assert(verified, 400, "payment_mismatch", "Payment amount, currency, or status does not match");
  if (order) {
    if (["pending", "payment_pending", "payment_error"].includes(order.status)) {
      await env.DB.prepare("UPDATE orders SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ?").bind(order.id).run();
      await enqueueJob(env, order.product_type === "card" ? "card_delivery" : "provision", order.id);
    }
    return json({ ok: true });
  }
  if (topup.status !== "paid") {
    const wallet = await ensureWallet(env, topup.user_id, topup.currency);
    const entryNo = reference("WE");
    const referenceId = String(topup.id);
    await env.DB.batch([
      env.DB.prepare(`UPDATE wallets SET balance_cents = balance_cents + ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND NOT EXISTS (SELECT 1 FROM wallet_entries WHERE wallet_id = ? AND kind = 'topup' AND reference_type = 'topup' AND reference_id = ?)`)
        .bind(topup.amount_cents, wallet.id, wallet.id, referenceId),
      env.DB.prepare(`INSERT OR IGNORE INTO wallet_entries(entry_no, wallet_id, kind, amount_cents, balance_after_cents, reference_type, reference_id, description)
        SELECT ?, id, 'topup', ?, balance_cents, 'topup', ?, ? FROM wallets WHERE id = ?`)
        .bind(entryNo, topup.amount_cents, referenceId, `Wallet top-up ${topup.topup_no}`, wallet.id),
      env.DB.prepare("UPDATE wallet_topups SET status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = ?").bind(topup.id),
    ]);
  }
  return json({ ok: true });
}
