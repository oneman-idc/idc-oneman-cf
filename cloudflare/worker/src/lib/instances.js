import { open, seal } from "./crypto.js";
import { accessDetails, clicdNodes, clicdRequest, containerDetails, findNode } from "./clicd.js";
import { nowIso } from "./util.js";

function meaningful(key, value) {
  if (value === undefined || value === null || value === "") return false;
  if (key === "ssh_port" && !Number(value)) return false;
  return key !== "status" || value !== "unknown";
}

export function mergeInstanceDetails(...sources) {
  const result = {};
  for (const source of sources) {
    for (const [key, value] of Object.entries(source || {})) if (meaningful(key, value)) result[key] = value;
  }
  return result;
}

export function completeAccessDetails(access, nodeUrl) {
  const result = { ...(access || {}) };
  if (result.access_code && !result.management_url) result.management_url = `${String(nodeUrl || "").replace(/\/+$/, "")}/login?code=${encodeURIComponent(result.access_code)}`;
  return result;
}

function enabled(value) {
  return value === true || value === 1 || value === "1";
}

export function deliveryReport(instance, access = {}) {
  const missing = [];
  const requireValue = (value, field) => { if (!String(value || "").trim()) missing.push(field); };
  requireValue(instance?.clicd_id, "container_id");
  requireValue(instance?.clicd_node, "container_node");
  requireValue(instance?.remote_name || instance?.name, "container_name");
  requireValue(instance?.expires_at, "expires_at");
  if (!instance?.status || new Set(["unknown", "provisioning"]).has(String(instance.status).toLowerCase())) missing.push("status");

  const ipv4Required = enabled(instance?.assign_ipv4) || enabled(instance?.assign_nat);
  const ipv6Required = enabled(instance?.assign_ipv6);
  if (ipv4Required) requireValue(instance?.ip, "ipv4");
  if (ipv6Required) requireValue(instance?.ipv6, "ipv6");
  if (ipv4Required || ipv6Required) {
    if (!(Number(instance?.ssh_port) > 0)) missing.push("ssh_port");
    requireValue(access.ssh_username, "ssh_username");
    requireValue(access.ssh_password, "ssh_password");
  }
  for (const field of ["username", "password", "access_code", "management_url"]) requireValue(access[field], `management_${field}`);
  return { complete: missing.length === 0, missing };
}

export async function syncInstance(env, instance) {
  if (!instance?.clicd_id) return instance;
  const node = findNode(await clicdNodes(env), instance.clicd_node);
  const response = await clicdRequest(node, "GET", `/containers/${encodeURIComponent(instance.clicd_id)}`);
  const details = containerDetails(response);
  let previousAccess = {};
  try { previousAccess = JSON.parse(await open(instance.access_ciphertext, env.MASTER_KEY) || "{}"); } catch { /* replace invalid legacy data */ }
  const access = completeAccessDetails(mergeInstanceDetails(previousAccess, {
    ssh_username: details.username || previousAccess.ssh_username || "root",
    ssh_password: details.ssh_password,
  }, accessDetails(response)), node.url);
  const next = {
    ...instance,
    remote_name: details.name || instance.remote_name || instance.name,
    status: meaningful("status", details.status) ? details.status : instance.status,
    ip: details.ip || instance.ip || "",
    ipv6: details.ipv6 || instance.ipv6 || "",
    ssh_port: details.ssh_port || instance.ssh_port || 22,
    access_ciphertext: await seal(JSON.stringify(access), env.MASTER_KEY),
    last_synced_at: nowIso(),
  };
  const report = deliveryReport(next, access);
  next.details_state = report.complete ? "complete" : "pending";
  next.details_error = report.missing.join(",");
  next.missing_details = report.missing;
  next._became_ready = report.complete && instance.details_state !== "complete";
  await env.DB.batch([
    env.DB.prepare(`UPDATE instances SET remote_name = ?, status = ?, ip = ?, ipv6 = ?, ssh_port = ?, access_ciphertext = ?,
      details_state = ?, details_error = ?, last_synced_at = ? WHERE id = ?`)
      .bind(next.remote_name, next.status, next.ip, next.ipv6, next.ssh_port, next.access_ciphertext, next.details_state, next.details_error, next.last_synced_at, instance.id),
    ...(report.complete ? [env.DB.prepare("UPDATE orders SET status = 'fulfilled', fulfilled_at = COALESCE(fulfilled_at, CURRENT_TIMESTAMP) WHERE id = ? AND status IN ('paid', 'provisioning')").bind(instance.order_id)] : []),
  ]);
  return next;
}

export function needsInstanceSync(instance, maxAgeMs = 120_000) {
  const lastSync = new Date(instance?.last_synced_at || 0).getTime();
  const stale = !Number.isFinite(lastSync) || Date.now() - lastSync > maxAgeMs;
  const transient = new Set(["provisioning", "starting", "stopping", "restarting", "unknown"]).has(String(instance?.status || "").toLowerCase());
  const missingIpv4 = Boolean(instance?.assign_ipv4 || instance?.assign_nat) && !instance?.ip;
  const missingIpv6 = Boolean(instance?.assign_ipv6) && !instance?.ipv6;
  return transient || missingIpv4 || missingIpv6 || stale || instance?.details_state !== "complete";
}
