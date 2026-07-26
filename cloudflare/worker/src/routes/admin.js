import { fingerprint, seal } from "../lib/crypto.js";
import { clicdNodes, clicdRequest, findNode, imageCatalog, listItems, normalizeClicdUrl } from "../lib/clicd.js";
import { audit, getSetting, getSettings, requireCsrf, requireUser, setSettings } from "../lib/db.js";
import { enqueueJob } from "../lib/jobs.js";
import { sendMail } from "../lib/mail.js";
import { asInt, assert, bodyJson, clientIp, json, normalizeEmail, randomToken } from "../lib/util.js";

export async function summary(request, env) {
  const user = await requireUser(request, env, true);
  const stats = await env.DB.prepare(`SELECT
    (SELECT COUNT(*) FROM users) users,
    (SELECT COUNT(*) FROM plans) plans,
    (SELECT COUNT(*) FROM orders) orders,
    (SELECT COUNT(*) FROM instances WHERE status != 'deleted') instances,
    (SELECT COUNT(*) FROM refund_requests WHERE status = 'pending_review') pending_refunds,
    (SELECT COUNT(*) FROM jobs WHERE status IN ('pending', 'failed')) open_jobs`).first();
  const orders = await env.DB.prepare("SELECT order_no, product_type, amount_cents, currency, status, created_at FROM orders ORDER BY id DESC LIMIT 20").all();
  const jobs = await env.DB.prepare("SELECT job_key, kind, status, attempts, error, updated_at FROM jobs ORDER BY id DESC LIMIT 20").all();
  return json({ ok: true, stats, orders: orders.results || [], jobs: jobs.results || [], csrf_token: user.csrf_token });
}

export async function retryJob(request, env, jobId) {
  const user = await requireUser(request, env, true);
  requireCsrf(request, user);
  const job = await env.DB.prepare("SELECT id, job_key, status FROM jobs WHERE id = ?").bind(jobId).first();
  assert(job && job.status === "failed", 409, "job_not_retryable", "Only failed jobs can be retried");
  await env.DB.prepare("UPDATE jobs SET status = 'pending', attempts = 0, error = '', run_after = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(jobId).run();
  await env.JOBS.send({ jobKey: job.job_key });
  await audit(env, user.id, "admin.job.retry", job.job_key, clientIp(request));
  return json({ ok: true, job_key: job.job_key });
}

export async function plans(request, env) {
  const user = await requireUser(request, env, true);
  const rows = await env.DB.prepare(`SELECT p.*,
    (SELECT COUNT(*) FROM card_items c WHERE c.plan_id = p.id AND c.status = 'available') card_available,
    (SELECT COUNT(*) FROM card_items c WHERE c.plan_id = p.id AND c.status = 'delivered') card_delivered
    FROM plans p ORDER BY p.sort_order, p.id`).all();
  const deliveries = await env.DB.prepare(`SELECT o.order_no, o.status, o.created_at, p.name plan_name, c.masked_value, c.email_sent_at, c.error
    FROM orders o JOIN plans p ON p.id = o.plan_id LEFT JOIN card_items c ON c.order_id = o.id
    WHERE o.product_type = 'card' ORDER BY o.id DESC LIMIT 50`).all();
  return json({ ok: true, plans: rows.results || [], deliveries: deliveries.results || [], csrf_token: user.csrf_token });
}

async function validatedCloudSelection(env, body) {
  const virtualization = String(body.virtualization || "").toLowerCase();
  assert(new Set(["lxc", "kvm"]).has(virtualization), 422, "invalid_virtualization", "Virtualization must be LXC or KVM");
  const nodeUrl = String(body.clicd_node || "").replace(/\/+$/, "");
  const imageId = String(body.clicd_image || "");
  const node = findNode(await clicdNodes(env), nodeUrl);
  const images = listItems(await clicdRequest(node, "GET", "/images/enabled", undefined, { type: virtualization }));
  const image = images.find((item) => String(item.id || item.template_id || item.slug || "") === imageId);
  assert(image, 422, "clicd_image_mismatch", "Selected CLICD image is not enabled for this node and virtualization type");
  return { node, image, virtualization, imageId };
}

export async function savePlan(request, env) {
  const user = await requireUser(request, env, true);
  requireCsrf(request, user);
  const body = await bodyJson(request, 1_000_000);
  const id = asInt(body.id, 0, 0);
  const productType = String(body.product_type || "cloud");
  assert(new Set(["cloud", "card"]).has(productType), 422, "invalid_product_type", "Product type is invalid");
  const name = String(body.name || "").trim().slice(0, 100);
  const slug = String(body.slug || "").trim().toLowerCase().slice(0, 100);
  assert(name && /^[a-z0-9][a-z0-9-]{1,99}$/.test(slug), 422, "invalid_plan_identity", "Plan name or slug is invalid");
  const priceCents = asInt(body.price_cents, 0, 1, 100_000_000);
  const active = body.active ? 1 : 0;
  let cloud = { node: { url: "" }, image: {}, virtualization: "lxc", imageId: "" };
  if (productType === "cloud") cloud = await validatedCloudSelection(env, body);
  const values = [
    name, slug, String(body.description || "").slice(0, 4000), productType, String(body.card_delivery_note || "").slice(0, 4000),
    priceCents, String(body.currency || "CNY").toUpperCase().slice(0, 8), asInt(body.months, 1, 1, 120),
    productType === "card" ? 0 : -1, asInt(body.sort_order, 0, -10000, 10000),
    cloud.virtualization, asInt(body.cpu, 1, 1, 256), asInt(body.memory_mb, 512, 128, 1_048_576), asInt(body.disk_gb, 10, 1, 1_000_000),
    asInt(body.traffic_gb, 0, 0, 1_000_000), asInt(body.network_down_mbps, 100, 0, 1_000_000), asInt(body.network_up_mbps, 50, 0, 1_000_000),
    cloud.node.url, cloud.imageId, String(cloud.image.name || cloud.image.label || cloud.imageId), body.assign_nat ? 1 : 0,
    body.assign_nat ? asInt(body.port_mapping_count, 2, 2, 64) : 0, body.assign_ipv4 ? 1 : 0, body.assign_ipv6 ? 1 : 0, active,
  ];
  let plan;
  if (id) {
    plan = await env.DB.prepare(`UPDATE plans SET name=?, slug=?, description=?, product_type=?, card_delivery_note=?, price_cents=?, currency=?, months=?, stock=?, sort_order=?,
      virtualization=?, cpu=?, memory_mb=?, disk_gb=?, traffic_gb=?, network_down_mbps=?, network_up_mbps=?, clicd_node=?, clicd_image=?, clicd_template_name=?,
      assign_nat=?, port_mapping_count=?, assign_ipv4=?, assign_ipv6=?, active=?, updated_at=CURRENT_TIMESTAMP WHERE id=? RETURNING *`).bind(...values, id).first();
    assert(plan, 404, "plan_not_found", "Plan was not found");
  } else {
    plan = await env.DB.prepare(`INSERT INTO plans(name,slug,description,product_type,card_delivery_note,price_cents,currency,months,stock,sort_order,
      virtualization,cpu,memory_mb,disk_gb,traffic_gb,network_down_mbps,network_up_mbps,clicd_node,clicd_image,clicd_template_name,
      assign_nat,port_mapping_count,assign_ipv4,assign_ipv6,active) VALUES(${values.map(() => "?").join(",")}) RETURNING *`).bind(...values).first();
  }
  await audit(env, user.id, "admin.plan.save", `${plan.id}:${plan.slug}`, clientIp(request));
  return json({ ok: true, plan }, id ? 200 : 201);
}

export async function togglePlan(request, env, planId) {
  const user = await requireUser(request, env, true);
  requireCsrf(request, user);
  const plan = await env.DB.prepare("UPDATE plans SET active = CASE active WHEN 1 THEN 0 ELSE 1 END, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING *").bind(planId).first();
  assert(plan, 404, "plan_not_found", "Plan was not found");
  return json({ ok: true, plan });
}

function maskSecret(value) {
  const compact = value.trim().replace(/\s+/g, " ");
  return `********${compact.slice(-4) || ""}`;
}

export async function importCards(request, env, planId) {
  const user = await requireUser(request, env, true);
  requireCsrf(request, user);
  const body = await bodyJson(request, 2_500_000);
  const plan = await env.DB.prepare("SELECT * FROM plans WHERE id = ? AND product_type = 'card'").bind(planId).first();
  assert(plan, 404, "card_plan_not_found", "Digital delivery plan was not found");
  const values = [...new Set(String(body.inventory || "").replace(/\r/g, "").split("\n").map((line) => line.trim()).filter(Boolean))];
  assert(values.length > 0 && values.length <= 500 && values.every((value) => value.length <= 4000), 422, "invalid_card_inventory", "Import 1-500 codes, each no longer than 4000 characters");
  let added = 0;
  for (let index = 0; index < values.length; index += 50) {
    const statements = [];
    for (const value of values.slice(index, index + 50)) statements.push(env.DB.prepare("INSERT OR IGNORE INTO card_items(plan_id, secret_ciphertext, secret_fingerprint, masked_value) VALUES(?, ?, ?, ?)").bind(planId, await seal(value, env.MASTER_KEY), await fingerprint(value, env.SECRET_KEY), maskSecret(value)));
    const results = await env.DB.batch(statements);
    added += results.reduce((total, result) => total + Number(result.meta?.changes || 0), 0);
  }
  await env.DB.prepare("UPDATE plans SET stock = (SELECT COUNT(*) FROM card_items WHERE plan_id = ? AND status = 'available'), updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(planId, planId).run();
  return json({ ok: true, added, skipped: values.length - added });
}

export async function refunds(request, env) {
  const user = await requireUser(request, env, true);
  const rows = await env.DB.prepare(`SELECT r.*, u.username, u.email, o.order_no, i.clicd_id, i.clicd_node
    FROM refund_requests r JOIN users u ON u.id = r.user_id JOIN orders o ON o.id = r.order_id
    LEFT JOIN instances i ON i.order_id = o.id ORDER BY r.id DESC LIMIT 200`).all();
  return json({ ok: true, refunds: rows.results || [], csrf_token: user.csrf_token });
}

export async function reviewRefund(request, env, refundId, action) {
  const user = await requireUser(request, env, true);
  requireCsrf(request, user);
  const body = await bodyJson(request);
  const refund = await env.DB.prepare("SELECT * FROM refund_requests WHERE id = ?").bind(refundId).first();
  assert(refund, 404, "refund_not_found", "Refund request was not found");
  if (action === "approve") {
    assert(["pending_review", "processing_failed"].includes(refund.status), 409, "refund_not_reviewable", "Refund request cannot be approved");
    await env.DB.prepare("UPDATE refund_requests SET status='approved', reviewed_at=CURRENT_TIMESTAMP, reviewed_by=?, review_note=?, error='' WHERE id=?")
      .bind(user.id, String(body.review_note || "").slice(0, 500), refundId).run();
    await enqueueJob(env, "refund", refundId, {}, randomToken(5));
  } else if (action === "reject") {
    assert(refund.status === "pending_review", 409, "refund_not_reviewable", "Refund request cannot be rejected");
    await env.DB.prepare("UPDATE refund_requests SET status='rejected', reviewed_at=CURRENT_TIMESTAMP, reviewed_by=?, review_note=? WHERE id=?")
      .bind(user.id, String(body.review_note || "").slice(0, 500), refundId).run();
  } else if (action === "retry") {
    assert(["processing_failed", "approved", "processing"].includes(refund.status), 409, "refund_not_retryable", "Refund cannot be retried");
    await env.DB.prepare("UPDATE refund_requests SET status='approved', error='' WHERE id=?").bind(refundId).run();
    await enqueueJob(env, "refund", refundId, {}, randomToken(5));
  } else assert(false, 422, "invalid_review_action", "Review action is invalid");
  await audit(env, user.id, `admin.refund.${action}`, String(refundId), clientIp(request));
  return json({ ok: true });
}

export async function getSettingsRoute(request, env) {
  const user = await requireUser(request, env, true);
  const values = await getSettings(env, ["site_name", "site_tagline", "site_footer", "site_url", "hashpay_base_url", "hashpay_merchant_id", "resend_from"]);
  const nodes = await clicdNodes(env).catch(() => []);
  values.clicd_nodes = nodes.map((node) => ({ url: node.url, label: node.label, token_configured: Boolean(node.token), insecure: node.url.startsWith("http://") }));
  values.hashpay_private_key_configured = Boolean(await getSetting(env, "hashpay_private_key", ""));
  values.resend_api_token_configured = Boolean(env.RESEND_API_TOKEN);
  return json({ ok: true, settings: values, csrf_token: user.csrf_token });
}

export async function saveSettingsRoute(request, env) {
  const user = await requireUser(request, env, true);
  requireCsrf(request, user);
  const body = await bodyJson(request, 1_000_000);
  const allowed = ["site_name", "site_tagline", "site_footer", "site_url", "hashpay_base_url", "hashpay_merchant_id", "hashpay_private_key", "resend_from"];
  const values = Object.fromEntries(allowed.filter((key) => Object.hasOwn(body, key) && (key !== "hashpay_private_key" || body[key])).map((key) => [key, String(body[key] || "").trim()]));
  for (const key of ["site_url", "hashpay_base_url"]) if (values[key]) assert(new URL(values[key]).protocol === "https:" || env.ALLOW_INSECURE_UPSTREAMS === "true", 422, "https_required", `${key} must use HTTPS`);
  if (Array.isArray(body.clicd_nodes)) {
    const existing = await clicdNodes(env).catch(() => []);
    const nodes = body.clicd_nodes.map((item, index) => {
      const url = normalizeClicdUrl(item.url, 422);
      const token = String(item.token || existing.find((old) => old.url === url)?.token || "");
      assert(token, 422, "clicd_token_required", `CLICD token is required for node ${index + 1}`);
      return { url, token, label: String(item.label || `CLICD ${index + 1}`).slice(0, 100) };
    });
    values.clicd_nodes_json = JSON.stringify(nodes);
  }
  await setSettings(env, values);
  await audit(env, user.id, "admin.settings.save", Object.keys(values).join(","), clientIp(request));
  return json({ ok: true });
}

export async function testResend(request, env) {
  const user = await requireUser(request, env, true);
  requireCsrf(request, user);
  const body = await bodyJson(request);
  const recipient = normalizeEmail(body.recipient || user.email);
  assert(recipient, 422, "invalid_email", "Enter a valid test recipient");
  const result = await sendMail(
    env,
    recipient,
    "VPS-ONE Resend delivery test",
    `Resend delivery is configured correctly.\n\nRequested by ${user.email}.`,
    { idempotencyKey: `resend-test:${user.id}:${Date.now()}` },
  );
  await audit(env, user.id, "admin.settings.test.resend", recipient, clientIp(request));
  return json({ ok: true, id: String(result?.id || ""), recipient });
}

export async function catalog(request, env) {
  await requireUser(request, env, true);
  return json({ ok: true, images: await imageCatalog(env) });
}

export async function products(request, env) {
  const user = await requireUser(request, env, true);
  const nodes = await clicdNodes(env);
  const containers = [];
  const errors = [];
  for (const node of nodes) {
    try {
      for (const item of listItems(await clicdRequest(node, "GET", "/containers"))) containers.push({ ...item, _node: node.url, _node_label: node.label });
    } catch (error) { errors.push({ node: node.label, error: String(error.message || error) }); }
  }
  return json({ ok: true, containers, errors, csrf_token: user.csrf_token });
}

export async function productAction(request, env, action) {
  const user = await requireUser(request, env, true);
  requireCsrf(request, user);
  assert(new Set(["start", "stop", "restart", "delete"]).has(action), 422, "invalid_action", "Container action is invalid");
  const body = await bodyJson(request);
  const node = findNode(await clicdNodes(env), String(body.node || ""));
  const id = String(body.id || "");
  assert(id, 422, "container_required", "Container ID is required");
  const path = action === "delete" ? `/containers/${encodeURIComponent(id)}/delete` : `/containers/${encodeURIComponent(id)}/${action}`;
  const result = await clicdRequest(node, action === "delete" ? "DELETE" : "POST", path, action === "delete" ? undefined : {});
  await audit(env, user.id, `admin.container.${action}`, `${node.url}:${id}`, clientIp(request));
  return json({ ok: true, result });
}
