import { confirmationHash, equalText, open, seal } from "../lib/crypto.js";
import { clicdNodes, clicdRequest, containerDetails, findNode } from "../lib/clicd.js";
import { audit, ensureWallet, requireCsrf, requireUser } from "../lib/db.js";
import { createCheckout } from "../lib/hashpay.js";
import { enqueueJob } from "../lib/jobs.js";
import { deliveryReport, needsInstanceSync, syncInstance } from "../lib/instances.js";
import { asInt, assert, bodyJson, clientIp, futureIso, json, randomCode, randomToken, reference } from "../lib/util.js";

function planSnapshot(plan) {
  const keys = ["name", "product_type", "card_delivery_note", "currency", "months", "virtualization", "cpu", "memory_mb", "disk_gb", "traffic_gb", "network_down_mbps", "network_up_mbps", "clicd_node", "clicd_image", "assign_nat", "port_mapping_count", "assign_ipv4", "assign_ipv6"];
  return Object.fromEntries(keys.map((key) => [key, plan[key]]));
}

export async function account(request, env) {
  const user = await requireUser(request, env);
  const wallet = await ensureWallet(env, user.id);
  const [entries, topups, orders, instances, refunds] = await Promise.all([
    env.DB.prepare("SELECT * FROM wallet_entries WHERE wallet_id = ? ORDER BY id DESC LIMIT 100").bind(wallet.id).all(),
    env.DB.prepare("SELECT * FROM wallet_topups WHERE user_id = ? ORDER BY id DESC LIMIT 100").bind(user.id).all(),
    env.DB.prepare(`SELECT o.*, p.name plan_name, c.masked_value, c.email_sent_at, c.error card_error
      FROM orders o JOIN plans p ON p.id = o.plan_id LEFT JOIN card_items c ON c.order_id = o.id
      WHERE o.user_id = ? ORDER BY o.id DESC LIMIT 100`).bind(user.id).all(),
    env.DB.prepare(`SELECT i.*, p.name plan_name, p.virtualization, p.assign_nat, p.assign_ipv4, p.assign_ipv6, o.order_no, o.status order_status FROM instances i
      JOIN plans p ON p.id = i.plan_id JOIN orders o ON o.id = i.order_id
      WHERE i.user_id = ? AND i.status != 'deleted' ORDER BY i.id DESC LIMIT 100`).bind(user.id).all(),
    env.DB.prepare("SELECT * FROM refund_requests WHERE user_id = ? ORDER BY id DESC LIMIT 100").bind(user.id).all(),
  ]);
  const instanceRows = instances.results || [];
  const synced = await Promise.all(instanceRows.slice(0, 20).map(async (instance) => {
    if (!needsInstanceSync(instance)) return instance;
    try { return await syncInstance(env, instance); } catch { return instance; }
  }));
  for (const instance of synced) {
    if (instance._became_ready) await enqueueJob(env, "mail_instance", instance.id, {}, "initial");
  }
  const syncedById = new Map(synced.map((instance) => [instance.id, instance]));
  const publicInstances = instanceRows.map((instance) => {
    const current = syncedById.get(instance.id) || instance;
    const { access_ciphertext, _became_ready, ...safe } = current;
    return { ...safe, missing_details: current.missing_details || String(current.details_error || "").split(",").filter(Boolean) };
  });
  const completedOrders = new Set(publicInstances.filter((instance) => instance.details_state === "complete").map((instance) => instance.order_id));
  const publicOrders = (orders.results || []).map((order) => completedOrders.has(order.id) && ["paid", "provisioning"].includes(order.status)
    ? { ...order, status: "fulfilled" }
    : order);
  return json({ ok: true, user: { id: user.id, username: user.username, email: user.email, is_admin: user.is_admin === 1 }, wallet, entries: entries.results || [], topups: topups.results || [], orders: publicOrders, instances: publicInstances, refunds: refunds.results || [], csrf_token: user.csrf_token });
}

export async function createOrder(request, env) {
  const user = await requireUser(request, env);
  requireCsrf(request, user);
  const body = await bodyJson(request);
  const planId = asInt(body.plan_id, 0, 1);
  const method = String(body.payment_method || "hashpay");
  assert(new Set(["wallet", "hashpay"]).has(method), 422, "invalid_payment_method", "Payment method is invalid");
  const plan = await env.DB.prepare("SELECT * FROM plans WHERE id = ? AND active = 1 AND stock != 0").bind(planId).first();
  assert(plan, 404, "plan_unavailable", "Plan is unavailable");
  const wallet = await ensureWallet(env, user.id, plan.currency);
  assert(wallet.currency === plan.currency, 409, "currency_mismatch", "Wallet currency does not match the plan");
  const orderNo = reference("CF");
  const snapshot = JSON.stringify(planSnapshot(plan));
  if (method === "wallet") {
    const entryNo = reference("WE");
    const results = await env.DB.batch([
      env.DB.prepare(`INSERT INTO orders(order_no, user_id, plan_id, plan_snapshot, amount_cents, currency, status, product_type, payment_method, paid_at)
        SELECT ?, ?, ?, ?, ?, ?, 'paid', ?, 'wallet', CURRENT_TIMESTAMP
        WHERE EXISTS (SELECT 1 FROM wallets WHERE id = ? AND balance_cents >= ?)
          AND EXISTS (SELECT 1 FROM plans WHERE id = ? AND active = 1 AND stock != 0)`)
        .bind(orderNo, user.id, plan.id, snapshot, plan.price_cents, plan.currency, plan.product_type, wallet.id, plan.price_cents, plan.id),
      env.DB.prepare("UPDATE wallets SET balance_cents = balance_cents - ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND balance_cents >= ? AND EXISTS (SELECT 1 FROM orders WHERE order_no = ?)")
        .bind(plan.price_cents, wallet.id, plan.price_cents, orderNo),
      env.DB.prepare(`INSERT INTO wallet_entries(entry_no, wallet_id, kind, amount_cents, balance_after_cents, reference_type, reference_id, description)
        SELECT ?, id, 'purchase', ?, balance_cents, 'order', ?, ? FROM wallets WHERE id = ? AND EXISTS (SELECT 1 FROM orders WHERE order_no = ?)`)
        .bind(entryNo, -plan.price_cents, orderNo, `Plan purchase ${plan.name}`, wallet.id, orderNo),
      ...(plan.product_type === "card" && plan.stock > 0 ? [env.DB.prepare("UPDATE plans SET stock = stock - 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND stock > 0").bind(plan.id)] : []),
    ]);
    const stockChanged = plan.product_type !== "card" || plan.stock < 0 || Number(results[3]?.meta?.changes || 0) === 1;
    assert(Number(results[0]?.meta?.changes || 0) === 1 && Number(results[1]?.meta?.changes || 0) === 1 && stockChanged, 409, "wallet_or_stock_unavailable", "Wallet balance or product stock is insufficient");
    const order = await env.DB.prepare("SELECT * FROM orders WHERE order_no = ?").bind(orderNo).first();
    await enqueueJob(env, plan.product_type === "card" ? "card_delivery" : "provision", order.id);
    await audit(env, user.id, "order.wallet.created", orderNo, clientIp(request));
    return json({ ok: true, order, checkout_url: null }, 201);
  }
  const inserted = await env.DB.prepare(`INSERT INTO orders(order_no, user_id, plan_id, plan_snapshot, amount_cents, currency, status, product_type, payment_method)
    VALUES(?, ?, ?, ?, ?, ?, 'payment_pending', ?, 'hashpay') RETURNING *`)
    .bind(orderNo, user.id, plan.id, snapshot, plan.price_cents, plan.currency, plan.product_type).first();
  try {
    const checkout = await createCheckout(env, orderNo, plan.price_cents, plan.currency, plan.name, "/?payment=returned");
    await env.DB.prepare("UPDATE orders SET checkout_url = ?, hashpay_id = ? WHERE id = ?").bind(checkout.checkoutUrl, checkout.id, inserted.id).run();
    return json({ ok: true, order: { ...inserted, checkout_url: checkout.checkoutUrl, hashpay_id: checkout.id }, checkout_url: checkout.checkoutUrl }, 201);
  } catch (error) {
    await env.DB.prepare("UPDATE orders SET status = 'payment_error' WHERE id = ?").bind(inserted.id).run();
    throw error;
  }
}

export async function createTopup(request, env) {
  const user = await requireUser(request, env);
  requireCsrf(request, user);
  const body = await bodyJson(request);
  const amountCents = Math.round(Number(body.amount) * 100);
  assert(Number.isInteger(amountCents) && amountCents >= 100 && amountCents <= 5_000_000, 422, "invalid_amount", "Top-up amount must be between 1.00 and 50000.00");
  const wallet = await ensureWallet(env, user.id);
  const topupNo = reference("TU");
  const topup = await env.DB.prepare("INSERT INTO wallet_topups(topup_no, user_id, wallet_id, amount_cents, currency) VALUES(?, ?, ?, ?, ?) RETURNING *")
    .bind(topupNo, user.id, wallet.id, amountCents, wallet.currency).first();
  try {
    const checkout = await createCheckout(env, topupNo, amountCents, wallet.currency, `${user.username} wallet top-up`, "/?view=account&topup=returned");
    await env.DB.prepare("UPDATE wallet_topups SET checkout_url = ?, hashpay_id = ? WHERE id = ?").bind(checkout.checkoutUrl, checkout.id, topup.id).run();
    return json({ ok: true, checkout_url: checkout.checkoutUrl, topup: { ...topup, checkout_url: checkout.checkoutUrl } }, 201);
  } catch (error) {
    await env.DB.prepare("UPDATE wallet_topups SET status = 'payment_error' WHERE id = ?").bind(topup.id).run();
    throw error;
  }
}

export async function requestRefund(request, env, orderId) {
  const user = await requireUser(request, env);
  requireCsrf(request, user);
  const body = await bodyJson(request);
  const order = await env.DB.prepare("SELECT * FROM orders WHERE id = ? AND user_id = ?").bind(orderId, user.id).first();
  assert(order && order.product_type === "cloud" && order.status === "fulfilled" && order.paid_at, 409, "refund_not_eligible", "This order is not eligible for cancellation");
  assert(Date.now() - new Date(order.paid_at).getTime() <= 86_400_000, 409, "refund_window_closed", "The 24-hour cancellation window has closed");
  const recent = await env.DB.prepare("SELECT COUNT(*) count FROM refund_requests WHERE user_id = ? AND requested_at >= datetime('now', '-24 hours')").bind(user.id).first();
  assert(Number(recent?.count || 0) < 5, 429, "refund_limit_reached", "Only five cancellation requests are allowed per rolling 24 hours");
  assert(!(await env.DB.prepare("SELECT 1 FROM refund_requests WHERE order_id = ?").bind(orderId).first()), 409, "refund_exists", "A cancellation request already exists for this order");
  const code = randomCode();
  const refundNo = reference("RF");
  const refund = await env.DB.prepare(`INSERT INTO refund_requests(refund_no, order_id, user_id, amount_cents, currency, reason, confirmation_hash, confirmation_expires_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`).bind(refundNo, orderId, user.id, order.amount_cents, order.currency, String(body.reason || "").slice(0, 500), await confirmationHash(refundNo, code, env.SECRET_KEY), futureIso(15 * 60_000)).first();
  await enqueueJob(env, "refund_code", refund.id, { code }, randomToken(5));
  return json({ ok: true, refund: { ...refund, confirmation_hash: undefined } }, 201);
}

export async function confirmRefund(request, env, refundId) {
  const user = await requireUser(request, env);
  requireCsrf(request, user);
  const body = await bodyJson(request);
  const refund = await env.DB.prepare("SELECT * FROM refund_requests WHERE id = ? AND user_id = ?").bind(refundId, user.id).first();
  assert(refund && refund.status === "confirmation_pending", 409, "refund_not_confirmable", "Cancellation request cannot be confirmed");
  assert(refund.confirmation_attempts < 5, 423, "confirmation_locked", "Confirmation code is locked; request a new code");
  assert(new Date(refund.confirmation_expires_at).getTime() > Date.now(), 410, "confirmation_expired", "Confirmation code has expired");
  const expected = await confirmationHash(refund.refund_no, String(body.code || ""), env.SECRET_KEY);
  if (!equalText(expected, refund.confirmation_hash)) {
    await env.DB.prepare("UPDATE refund_requests SET confirmation_attempts = confirmation_attempts + 1 WHERE id = ?").bind(refundId).run();
    assert(false, 422, "confirmation_invalid", "Confirmation code is invalid");
  }
  await env.DB.prepare("UPDATE refund_requests SET status = 'pending_review', confirmed_at = CURRENT_TIMESTAMP, confirmation_hash = '' WHERE id = ?").bind(refundId).run();
  return json({ ok: true });
}

export async function resendRefund(request, env, refundId) {
  const user = await requireUser(request, env);
  requireCsrf(request, user);
  const refund = await env.DB.prepare("SELECT * FROM refund_requests WHERE id = ? AND user_id = ?").bind(refundId, user.id).first();
  assert(refund && refund.status === "confirmation_pending" && refund.email_attempts < 5, 409, "refund_code_unavailable", "A new confirmation code cannot be sent");
  const code = randomCode();
  await env.DB.prepare("UPDATE refund_requests SET confirmation_hash = ?, confirmation_expires_at = ?, confirmation_attempts = 0 WHERE id = ?")
    .bind(await confirmationHash(refund.refund_no, code, env.SECRET_KEY), futureIso(15 * 60_000), refundId).run();
  await enqueueJob(env, "refund_code", refundId, { code }, randomToken(5));
  return json({ ok: true });
}

export async function instanceAccess(request, env, instanceId) {
  const user = await requireUser(request, env);
  let instance = await env.DB.prepare(`SELECT i.*, p.assign_nat, p.assign_ipv4, p.assign_ipv6 FROM instances i
    JOIN plans p ON p.id = i.plan_id WHERE i.id = ? AND i.user_id = ? AND i.status != 'deleted'`).bind(instanceId, user.id).first();
  assert(instance, 404, "instance_not_found", "Instance was not found");
  try { instance = await syncInstance(env, instance); } catch { /* return the last known details when CLICD is temporarily unavailable */ }
  const access = JSON.parse(await open(instance.access_ciphertext, env.MASTER_KEY) || "{}");
  const report = deliveryReport(instance, access);
  assert(report.complete, 409, "instance_details_pending", "Container details are still being synchronized", report.missing);
  if (instance._became_ready) await enqueueJob(env, "mail_instance", instance.id, {}, "initial");
  const { access_ciphertext, _became_ready, ...safe } = instance;
  return json({ ok: true, instance: safe, access });
}

export async function resendCard(request, env, orderId) {
  const user = await requireUser(request, env);
  requireCsrf(request, user);
  const order = await env.DB.prepare(`SELECT o.id, o.status, o.product_type, c.id card_id, c.status card_status
    FROM orders o JOIN card_items c ON c.order_id = o.id WHERE o.id = ? AND o.user_id = ?`).bind(orderId, user.id).first();
  assert(order && order.product_type === "card" && order.status === "fulfilled" && order.card_status === "delivered", 409, "card_email_unavailable", "Card delivery email cannot be resent");
  const recent = await env.DB.prepare("SELECT COUNT(*) count FROM jobs WHERE kind = 'card_delivery' AND ref_id = ? AND job_key != ? AND created_at >= datetime('now', '-1 hour')").bind(orderId, `card_delivery:${orderId}`).first();
  assert(Number(recent?.count || 0) < 3, 429, "card_email_rate_limited", "Only three resend requests are allowed per hour");
  await enqueueJob(env, "card_delivery", orderId, { resend: true }, randomToken(5));
  return json({ ok: true });
}

export async function instanceAction(request, env, instanceId, action) {
  const user = await requireUser(request, env);
  requireCsrf(request, user);
  assert(new Set(["start", "stop", "restart", "reset-password"]).has(action), 422, "invalid_action", "Instance action is not allowed");
  const instance = await env.DB.prepare("SELECT * FROM instances WHERE id = ? AND user_id = ? AND status != 'deleted'").bind(instanceId, user.id).first();
  assert(instance?.clicd_id, 404, "instance_not_found", "Instance was not found");
  const node = findNode(await clicdNodes(env), instance.clicd_node);
  let payload = {};
  if (action === "reset-password") payload = { password: `${randomToken(16)}aA1!` };
  const result = await clicdRequest(node, "POST", `/containers/${encodeURIComponent(instance.clicd_id)}/${action}`, payload);
  if (action === "reset-password") {
    const access = JSON.parse(await open(instance.access_ciphertext, env.MASTER_KEY) || "{}");
    access.ssh_password = String(result?.data?.password || result?.password || payload.password);
    await env.DB.prepare("UPDATE instances SET access_ciphertext = ?, last_synced_at = CURRENT_TIMESTAMP WHERE id = ?").bind(await seal(JSON.stringify(access), env.MASTER_KEY), instanceId).run();
    await enqueueJob(env, "mail_instance", instanceId, {}, randomToken(5));
  } else {
    await env.DB.prepare("UPDATE instances SET status = ?, last_synced_at = CURRENT_TIMESTAMP WHERE id = ?").bind(action === "stop" ? "stopping" : `${action}ing`, instanceId).run();
  }
  await audit(env, user.id, `instance.${action}`, String(instanceId), clientIp(request));
  return json({ ok: true, result });
}
