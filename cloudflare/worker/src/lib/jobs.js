import { open, seal } from "./crypto.js";
import { accessDetails, clicdNodes, clicdRequest, containerDetails, findNode, listItems, planPayload, unwrap } from "./clicd.js";
import { cleanupExpired, ensureWallet } from "./db.js";
import { completeAccessDetails, deliveryReport, mergeInstanceDetails, syncInstance } from "./instances.js";
import { sendMail } from "./mail.js";
import { futureIso, nowIso, randomToken, reference } from "./util.js";

export async function enqueueJob(env, kind, refId, payload = {}, uniqueSuffix = "") {
  const jobKey = `${kind}:${refId}${uniqueSuffix ? `:${uniqueSuffix}` : ""}`;
  const encrypted = await seal(JSON.stringify(payload), env.MASTER_KEY);
  await env.DB.prepare(`INSERT INTO jobs(job_key, kind, ref_id, payload, status, run_after, updated_at)
    VALUES(?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(job_key) DO UPDATE SET payload = excluded.payload, status = CASE WHEN jobs.status = 'done' THEN jobs.status ELSE 'pending' END, error = '', run_after = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP`)
    .bind(jobKey, kind, refId, encrypted).run();
  await env.JOBS.send({ jobKey });
  return jobKey;
}

async function jobPayload(job, env) {
  try {
    return JSON.parse(await open(job.payload, env.MASTER_KEY) || "{}");
  } catch {
    return {};
  }
}

async function provision(env, orderId) {
  const row = await env.DB.prepare(`SELECT o.*, p.name plan_name, p.months, p.virtualization, p.cpu, p.memory_mb, p.disk_gb,
      p.traffic_gb, p.network_down_mbps, p.network_up_mbps, p.clicd_node, p.clicd_image,
      p.assign_nat, p.port_mapping_count, p.assign_ipv4, p.assign_ipv6, u.email, u.username,
      i.id instance_id, i.clicd_id existing_clicd_id, i.clicd_node existing_clicd_node,
      i.remote_name existing_remote_name, i.status existing_status, i.ip existing_ip, i.ipv6 existing_ipv6,
      i.ssh_port existing_ssh_port, i.access_ciphertext existing_access_ciphertext, i.expires_at existing_expires_at
    FROM orders o JOIN plans p ON p.id = o.plan_id JOIN users u ON u.id = o.user_id
    LEFT JOIN instances i ON i.order_id = o.id WHERE o.id = ?`).bind(orderId).first();
  if (!row || row.product_type !== "cloud" || !["paid", "provisioning", "fulfilled"].includes(row.status)) return;
  const nodes = await clicdNodes(env);
  const node = findNode(nodes, row.existing_clicd_node || row.clicd_node);
  const resourceName = `vps-${row.order_no.toLowerCase()}`;
  const expiresAt = row.existing_expires_at || futureIso(Math.max(1, Number(row.months || 1)) * 30 * 86_400_000);
  await env.DB.prepare("UPDATE orders SET status = 'provisioning' WHERE id = ? AND status IN ('paid', 'provisioning')").bind(row.id).run();
  let clicdId = row.existing_clicd_id;
  let createdResponse = null;
  if (!clicdId) {
    const existing = listItems(await clicdRequest(node, "GET", "/containers")).find((item) => String(item.name || item.hostname) === resourceName);
    if (existing) clicdId = String(existing.uuid || existing.id || existing.container_id || "");
    if (!clicdId) {
      createdResponse = await clicdRequest(node, "POST", "/containers", planPayload(row, row.order_no, expiresAt));
      const created = unwrap(createdResponse) || {};
      clicdId = String(created.uuid || created.id || created.container_id || "");
    }
  }
  if (!clicdId) throw new Error("CLICD did not return a container ID");
  const detailResponse = await clicdRequest(node, "GET", `/containers/${encodeURIComponent(clicdId)}`);
  const details = mergeInstanceDetails({
    id: clicdId,
    name: row.existing_remote_name || resourceName,
    status: row.existing_status,
    ip: row.existing_ip,
    ipv6: row.existing_ipv6,
    ssh_port: row.existing_ssh_port,
  }, containerDetails(createdResponse), containerDetails(detailResponse));
  if (!new Set(["running", "online", "started", "starting"]).has(details.status)) {
    await clicdRequest(node, "POST", `/containers/${encodeURIComponent(clicdId)}/start`, {});
    details.status = "starting";
  }
  let previousAccess = {};
  try { previousAccess = JSON.parse(await open(row.existing_access_ciphertext, env.MASTER_KEY) || "{}"); } catch { /* replace invalid legacy data */ }
  let access = mergeInstanceDetails(previousAccess, {
    ssh_username: details.username || previousAccess.ssh_username || "root",
    ssh_password: details.ssh_password,
  }, accessDetails(createdResponse), accessDetails(detailResponse));
  if (!access.username || !access.password || !access.access_code) {
    try {
      const createdUser = accessDetails(await clicdRequest(node, "POST", "/sub-user/create", { container_name: details.name || resourceName }));
      access = mergeInstanceDetails(access, createdUser);
    } catch (error) {
      access.access_warning = String(error.message || error);
    }
  }
  access = completeAccessDetails(access, node.url);
  const encryptedAccess = await seal(JSON.stringify(access), env.MASTER_KEY);
  const instanceName = `VPS-${row.order_no.slice(-8)}`;
  const projected = {
    ...row,
    clicd_id: clicdId,
    clicd_node: node.url,
    name: instanceName,
    remote_name: details.name || resourceName,
    status: details.status || "starting",
    ip: details.ip || "",
    ipv6: details.ipv6 || "",
    ssh_port: details.ssh_port || 22,
    expires_at: expiresAt,
  };
  const report = deliveryReport(projected, access);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO instances(user_id, order_id, plan_id, clicd_id, clicd_node, name, remote_name, status, ip, ipv6, ssh_port, access_ciphertext, expires_at, details_state, details_error, last_synced_at)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(order_id) DO UPDATE SET clicd_id = excluded.clicd_id, clicd_node = excluded.clicd_node, status = excluded.status,
      remote_name = excluded.remote_name, ip = excluded.ip, ipv6 = excluded.ipv6, ssh_port = excluded.ssh_port,
      access_ciphertext = excluded.access_ciphertext, expires_at = COALESCE(instances.expires_at, excluded.expires_at),
      details_state = excluded.details_state, details_error = excluded.details_error, last_synced_at = excluded.last_synced_at`)
      .bind(row.user_id, row.id, row.plan_id, clicdId, node.url, instanceName, projected.remote_name, projected.status, projected.ip, projected.ipv6, projected.ssh_port, encryptedAccess, expiresAt, report.complete ? "complete" : "pending", report.missing.join(","), nowIso()),
    env.DB.prepare(`UPDATE orders SET status = ?, fulfilled_at = CASE WHEN ? = 'fulfilled' THEN COALESCE(fulfilled_at, CURRENT_TIMESTAMP) ELSE fulfilled_at END WHERE id = ?`)
      .bind(report.complete ? "fulfilled" : "provisioning", report.complete ? "fulfilled" : "provisioning", row.id),
  ]);
  const instance = await env.DB.prepare("SELECT id FROM instances WHERE order_id = ?").bind(row.id).first();
  if (!report.complete) throw new Error(`CLICD instance details are incomplete: ${report.missing.join(", ")}`);
  await enqueueJob(env, "mail_instance", instance.id, {}, "initial");
}

async function mailInstance(env, instanceId, _payload, job) {
  let row = await env.DB.prepare(`SELECT i.*, u.email, o.order_no, p.name plan_name, p.virtualization, p.clicd_template_name,
    p.cpu, p.memory_mb, p.disk_gb, p.traffic_gb, p.network_down_mbps, p.network_up_mbps,
    p.assign_nat, p.assign_ipv4, p.assign_ipv6 FROM instances i
    JOIN users u ON u.id = i.user_id JOIN orders o ON o.id = i.order_id JOIN plans p ON p.id = i.plan_id WHERE i.id = ?`).bind(instanceId).first();
  if (!row) return;
  row = await syncInstance(env, row);
  const access = JSON.parse(await open(row.access_ciphertext, env.MASTER_KEY) || "{}");
  const report = deliveryReport(row, access);
  if (!report.complete) throw new Error(`CLICD instance access details are not ready: ${report.missing.join(", ")}`);
  const sshHost = row.ip || row.ipv6 || "";
  const sshCommand = sshHost ? `ssh -p ${row.ssh_port || 22} ${access.ssh_username || "root"}@${sshHost}` : "-";
  const lines = [
    `Order: ${row.order_no}`,
    `Plan: ${row.plan_name}`,
    `Virtualization: ${String(row.virtualization || "-").toUpperCase()}`,
    `Template: ${row.clicd_template_name || "-"}`,
    `Resources: ${row.cpu || "-"} vCPU / ${row.memory_mb || "-"} MB RAM / ${row.disk_gb || "-"} GB disk`,
    `Traffic: ${row.traffic_gb || 0} GB`,
    `Network: ${row.network_down_mbps || 0} Mbps down / ${row.network_up_mbps || 0} Mbps up`,
    `Instance: ${row.name}`,
    `Status: ${row.status}`,
    `IPv4: ${row.ip || "-"}`,
    `IPv6: ${row.ipv6 || "-"}`,
    `SSH port: ${row.ssh_port || 22}`,
    `SSH: ${sshCommand}`,
    `SSH username: ${access.ssh_username || "root"}`,
    `SSH password: ${access.ssh_password || "-"}`,
    `Management username: ${access.username || "-"}`,
    `Initial password: ${access.password || "-"}`,
    `Access code: ${access.access_code || "-"}`,
    `Management URL: ${access.management_url || "-"}`,
    "",
    "Store this message securely and rotate the initial password after first login.",
  ];
  await sendMail(env, row.email, `VPS-ONE instance ready: ${row.order_no}`, lines.join("\n"), { idempotencyKey: job?.job_key });
}

async function deliverCard(env, orderId, payload, job) {
  const order = await env.DB.prepare(`SELECT o.*, p.name plan_name, p.card_delivery_note, u.email FROM orders o
    JOIN plans p ON p.id = o.plan_id JOIN users u ON u.id = o.user_id WHERE o.id = ?`).bind(orderId).first();
  if (!order || order.product_type !== "card" || !["paid", "delivering", "delivery_failed", "fulfilled"].includes(order.status)) return;
  let item = await env.DB.prepare("SELECT * FROM card_items WHERE order_id = ?").bind(orderId).first();
  if (!item) {
    item = await env.DB.prepare(`UPDATE card_items SET order_id = ?, status = 'assigned', assigned_at = CURRENT_TIMESTAMP, error = ''
      WHERE id = (SELECT id FROM card_items WHERE plan_id = ? AND status = 'available' ORDER BY id LIMIT 1)
      RETURNING *`).bind(orderId, order.plan_id).first();
  }
  if (!item) {
    await env.DB.prepare("UPDATE orders SET status = 'delivery_failed' WHERE id = ?").bind(orderId).run();
    throw new Error("Card inventory is empty");
  }
  await env.DB.prepare("UPDATE plans SET stock = (SELECT COUNT(*) FROM card_items WHERE plan_id = ? AND status = 'available'), updated_at = CURRENT_TIMESTAMP WHERE id = ?").bind(order.plan_id, order.plan_id).run();
  if (item.status === "delivered" && item.email_sent_at && !payload.resend) return;
  const secret = await open(item.secret_ciphertext, env.MASTER_KEY);
  await sendMail(env, order.email, `VPS-ONE digital delivery: ${order.order_no}`, [
    `Order: ${order.order_no}`,
    `Product: ${order.plan_name}`,
    "",
    secret,
    "",
    order.card_delivery_note || "Keep this code secure.",
  ].join("\n"), { idempotencyKey: job?.job_key });
  await env.DB.batch([
    env.DB.prepare("UPDATE card_items SET status = 'delivered', delivered_at = CURRENT_TIMESTAMP, email_sent_at = CURRENT_TIMESTAMP, email_attempts = email_attempts + 1, error = '' WHERE id = ?").bind(item.id),
    env.DB.prepare("UPDATE orders SET status = 'fulfilled', fulfilled_at = COALESCE(fulfilled_at, CURRENT_TIMESTAMP) WHERE id = ?").bind(orderId),
  ]);
}

async function sendRefundCode(env, refundId, payload, job) {
  const row = await env.DB.prepare("SELECT r.refund_no, r.status, u.email FROM refund_requests r JOIN users u ON u.id = r.user_id WHERE r.id = ?").bind(refundId).first();
  if (!row || row.status !== "confirmation_pending") return;
  await sendMail(env, row.email, `VPS-ONE cancellation code: ${row.refund_no}`, `Confirmation code: ${payload.code}\n\nThis code expires in 15 minutes. Do not share it.`, { idempotencyKey: job?.job_key });
  await env.DB.prepare("UPDATE refund_requests SET email_attempts = email_attempts + 1 WHERE id = ?").bind(refundId).run();
}

async function processRefund(env, refundId) {
  const row = await env.DB.prepare(`SELECT r.*, o.order_no, o.status order_status, i.id instance_id, i.clicd_id, i.clicd_node,
    w.id wallet_id FROM refund_requests r JOIN orders o ON o.id = r.order_id
    LEFT JOIN instances i ON i.order_id = o.id LEFT JOIN wallets w ON w.user_id = r.user_id WHERE r.id = ?`).bind(refundId).first();
  if (!row || !["approved", "processing", "processing_failed"].includes(row.status)) return;
  await env.DB.prepare("UPDATE refund_requests SET status = 'processing', error = '' WHERE id = ?").bind(refundId).run();
  if (row.clicd_id && !row.container_deleted_at) {
    const node = findNode(await clicdNodes(env), row.clicd_node);
    try {
      await clicdRequest(node, "DELETE", `/containers/${encodeURIComponent(row.clicd_id)}/delete`);
    } catch (error) {
      if (!String(error.message || error).includes("(404)")) throw error;
    }
  }
  const wallet = row.wallet_id ? { id: row.wallet_id } : await ensureWallet(env, row.user_id, row.currency);
  const entryNo = reference("WE");
  const referenceId = String(refundId);
  await env.DB.batch([
    env.DB.prepare(`UPDATE wallets SET balance_cents = balance_cents + ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND NOT EXISTS (SELECT 1 FROM wallet_entries WHERE wallet_id = ? AND kind = 'refund' AND reference_type = 'refund' AND reference_id = ?)`)
      .bind(row.amount_cents, wallet.id, wallet.id, referenceId),
    env.DB.prepare(`INSERT OR IGNORE INTO wallet_entries(entry_no, wallet_id, kind, amount_cents, balance_after_cents, reference_type, reference_id, description)
      SELECT ?, id, 'refund', ?, balance_cents, 'refund', ?, ? FROM wallets WHERE id = ?`)
      .bind(entryNo, row.amount_cents, referenceId, `Order refund ${row.order_no}`, wallet.id),
    env.DB.prepare("UPDATE orders SET status = 'refunded' WHERE id = ?").bind(row.order_id),
    env.DB.prepare("UPDATE instances SET status = 'deleted' WHERE order_id = ?").bind(row.order_id),
    env.DB.prepare("UPDATE refund_requests SET status = 'completed', container_deleted_at = COALESCE(container_deleted_at, CURRENT_TIMESTAMP), refunded_at = COALESCE(refunded_at, CURRENT_TIMESTAMP), completed_at = CURRENT_TIMESTAMP, error = '' WHERE id = ?").bind(refundId),
  ]);
}

const handlers = {
  provision,
  mail_instance: mailInstance,
  card_delivery: deliverCard,
  refund_code: sendRefundCode,
  refund: processRefund,
};

export async function processJob(env, jobKey) {
  const job = await env.DB.prepare("SELECT * FROM jobs WHERE job_key = ?").bind(jobKey).first();
  if (!job || job.status === "done") return;
  const handler = handlers[job.kind];
  if (!handler) throw new Error(`Unknown job kind: ${job.kind}`);
  await env.DB.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP WHERE job_key = ?").bind(jobKey).run();
  try {
    await handler(env, job.ref_id, await jobPayload(job, env), job);
    await env.DB.prepare("UPDATE jobs SET status = 'done', error = '', updated_at = CURRENT_TIMESTAMP WHERE job_key = ?").bind(jobKey).run();
  } catch (error) {
    const attempts = Number(job.attempts || 0) + 1;
    const delaySeconds = Math.min(900, 10 * (2 ** attempts));
    await env.DB.prepare("UPDATE jobs SET status = ?, error = ?, run_after = datetime('now', ?), updated_at = CURRENT_TIMESTAMP WHERE job_key = ?")
      .bind(attempts >= 5 ? "failed" : "pending", String(error.message || error).slice(0, 1000), `+${delaySeconds} seconds`, jobKey).run();
    throw error;
  }
}

export async function consumeQueue(batch, env) {
  for (const message of batch.messages) {
    try {
      await processJob(env, message.body?.jobKey);
      message.ack();
    } catch (error) {
      console.error("queue job failed", message.body, error);
      message.retry();
    }
  }
}

export async function scheduledMaintenance(env) {
  await cleanupExpired(env);
  const due = await env.DB.prepare("SELECT job_key FROM jobs WHERE status = 'pending' AND run_after <= CURRENT_TIMESTAMP ORDER BY id LIMIT 50").all();
  if (due.results?.length) await env.JOBS.sendBatch(due.results.map((row) => ({ body: { jobKey: row.job_key } })));
}
