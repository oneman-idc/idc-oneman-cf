import { assert } from "./util.js";
import { getSetting } from "./db.js";

const USER_AGENT = "VPS-ONE-CLOUDFLARE/1.0";

function normalizedKey(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

function valuesByKey(value, keys, depth = 0, output = []) {
  if (!value || typeof value !== "object" || depth > 7) return output;
  for (const [key, child] of Object.entries(value)) {
    if (keys.has(normalizedKey(key))) output.push(child);
    if (child && typeof child === "object") valuesByKey(child, keys, depth + 1, output);
  }
  return output;
}

function scalarValues(value, output = []) {
  if (value === undefined || value === null) return output;
  if (["string", "number"].includes(typeof value)) output.push(String(value));
  else if (Array.isArray(value)) for (const child of value) scalarValues(child, output);
  else if (typeof value === "object") {
    const initialLength = output.length;
    for (const key of ["address", "ip", "value", "host", "url"]) if (Object.hasOwn(value, key)) scalarValues(value[key], output);
    if (output.length === initialLength) for (const child of Object.values(value)) scalarValues(child, output);
  }
  return output;
}

function firstText(roots, keys) {
  for (const key of keys) {
    const normalized = new Set([normalizedKey(key)]);
    for (const root of roots) {
      for (const value of valuesByKey(root, normalized)) {
        const result = scalarValues(value).map((item) => item.trim()).find(Boolean);
        if (result) return result;
      }
    }
  }
  return "";
}

function firstAddress(roots, keys, family) {
  for (const key of keys) {
    const normalized = new Set([normalizedKey(key)]);
    for (const root of roots) {
      for (const value of valuesByKey(root, normalized)) {
        for (const text of scalarValues(value)) {
          const candidates = text.replace(/[\[\]]/g, "").split(/[\s,;]+/).map((item) => item.split("/")[0]);
          for (const candidate of candidates) {
            if (family === 4 && /^(?:\d{1,3}\.){3}\d{1,3}$/.test(candidate)) return candidate;
            if (family === 6 && candidate.includes(":") && !candidate.includes("://") && /^[0-9a-f:]+$/i.test(candidate)) return candidate;
          }
        }
      }
    }
  }
  return "";
}

function firstPort(roots, keys) {
  const direct = Number(firstText(roots, keys));
  if (Number.isInteger(direct) && direct > 0 && direct <= 65535) return direct;
  const targetKeys = ["container_port", "guest_port", "internal_port", "private_port", "destination_port"].map(normalizedKey);
  const publicKeys = ["host_port", "public_port", "external_port", "source_port", "mapped_port"].map(normalizedKey);
  let found = 0;
  const scan = (value, depth = 0) => {
    if (found || !value || typeof value !== "object" || depth > 7) return;
    if (!Array.isArray(value)) {
      const entries = Object.fromEntries(Object.entries(value).map(([key, child]) => [normalizedKey(key), child]));
      const target = Number(targetKeys.map((key) => entries[key]).find((item) => item !== undefined));
      const external = Number(publicKeys.map((key) => entries[key]).find((item) => item !== undefined));
      if (target === 22 && Number.isInteger(external) && external > 0 && external <= 65535) found = external;
    }
    for (const child of Object.values(value)) scan(child, depth + 1);
  };
  for (const root of roots) scan(root);
  return found;
}

function normalizedStatus(value) {
  const status = String(value || "unknown").toLowerCase();
  if (new Set(["running", "started", "online", "up", "active"]).has(status)) return "running";
  if (new Set(["stopped", "stop", "offline", "down", "inactive", "exited"]).has(status)) return "stopped";
  if (new Set(["starting", "stopping", "restarting", "creating", "provisioning", "pending"]).has(status)) return status;
  return "unknown";
}

export function normalizeClicdUrl(value, status = 500) {
  const url = String(value || "").trim();
  let parsed;
  try { parsed = new URL(url); } catch { /* handled by the assertion below */ }
  assert(parsed && new Set(["http:", "https:"]).has(parsed.protocol), status, "invalid_clicd_url", "CLICD node URL must use HTTP or HTTPS");
  assert(!parsed.username && !parsed.password && !parsed.search && !parsed.hash, status, "invalid_clicd_url", "CLICD node URL cannot contain credentials, a query, or a fragment");
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
}

export async function clicdNodes(env) {
  const raw = await getSetting(env, "clicd_nodes_json", "[]");
  let values;
  try {
    values = JSON.parse(raw || "[]");
  } catch {
    throw new Error("CLICD node configuration is invalid JSON");
  }
  assert(Array.isArray(values), 500, "invalid_clicd_settings", "CLICD nodes must be an array");
  const nodes = values.map((item, index) => ({
    url: String(item.url || item.base_url || "").trim(),
    token: String(item.token || item.api_key || ""),
    label: String(item.label || `CLICD ${index + 1}`),
  })).filter((item) => item.url && item.token).map((item) => ({ ...item, url: normalizeClicdUrl(item.url) }));
  return nodes;
}

export function findNode(nodes, url = "") {
  const node = url ? nodes.find((item) => item.url === url.replace(/\/+$/, "")) : nodes[0];
  assert(node, 503, "clicd_unavailable", "No matching CLICD node is configured");
  return node;
}

export async function clicdRequest(node, method, path, data, query) {
  const url = new URL(`${node.url}/api/v1${path}`);
  for (const [key, value] of Object.entries(query || {})) url.searchParams.set(key, value);
  const response = await fetch(url, {
    method,
    headers: { "X-API-Key": node.token, Accept: "application/json", "Content-Type": "application/json", "User-Agent": USER_AGENT },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text();
  let result = {};
  try { result = text ? JSON.parse(text) : {}; } catch { throw new Error(`CLICD returned invalid JSON (${response.status})`); }
  if (!response.ok || result?.success === false) throw new Error(`CLICD request failed (${response.status}): ${String(result?.message || text).slice(0, 800)}`);
  return result;
}

export function unwrap(value) {
  let current = value;
  for (let depth = 0; depth < 4 && current && typeof current === "object" && !Array.isArray(current); depth += 1) {
    if (current.container && typeof current.container === "object") return current.container;
    if (current.data && typeof current.data === "object") current = current.data;
    else break;
  }
  return current;
}

export function listItems(value) {
  const data = unwrap(value);
  if (Array.isArray(data)) return data;
  for (const key of ["items", "containers", "images", "data"]) if (Array.isArray(data?.[key])) return data[key];
  return [];
}

export function accessDetails(value) {
  const aliases = {
    username: ["username", "user_name", "sub_username", "sub_user_name"],
    password: ["password", "initial_password", "sub_password", "login_password"],
    access_code: ["access_code", "code", "login_code"],
    management_url: ["management_url", "access_url", "login_url", "panel_url", "url"],
  };
  const scopes = new Set(["subuser", "subuserinfo", "credentials", "access", "data", "container", "result"]);
  const candidates = [];
  const visit = (current, depth = 0) => {
    if (!current || depth > 5) return;
    if (Array.isArray(current)) {
      for (const child of current.slice(0, 10)) visit(child, depth + 1);
      return;
    }
    if (typeof current !== "object") return;
    candidates.push(current);
    for (const [key, child] of Object.entries(current)) if (scopes.has(normalizedKey(key))) visit(child, depth + 1);
  };
  visit(value);
  const output = {};
  for (const [target, keys] of Object.entries(aliases)) {
    for (const candidate of candidates) {
      const normalized = Object.fromEntries(Object.entries(candidate).map(([key, value]) => [normalizedKey(key), value]));
      const found = keys.map((key) => normalized[normalizedKey(key)]).find((item) => item !== undefined && item !== null && item !== "");
      if (found !== undefined) { output[target] = String(found); break; }
    }
  }
  return output;
}

export function containerDetails(value) {
  const item = unwrap(value) || {};
  const roots = [item];
  return {
    id: firstText(roots, ["uuid", "container_id", "id"]),
    name: firstText(roots, ["name", "hostname", "container_name"]),
    status: normalizedStatus(firstText(roots, ["status", "state", "power_status"])),
    ip: firstAddress(roots, ["public_ipv4", "public_ipv4s", "nat_ipv4", "public_ip", "ipv4_address", "ipv4_addresses", "ipv4", "ip_address", "ip", "addresses"], 4),
    ipv6: firstAddress(roots, ["public_ipv6", "public_ipv6s", "ipv6_address", "ipv6_addresses", "ipv6", "ip_address", "ip", "addresses"], 6),
    ssh_port: firstPort(roots, ["ssh_port", "ssh_public_port", "public_ssh_port", "external_ssh_port"]),
    ssh_password: firstText(roots, ["ssh_password", "initial_password", "password"]),
    username: firstText(roots, ["ssh_username", "username", "user_name"]),
    access_code: firstText(roots, ["access_code"]),
    management_url: firstText(roots, ["management_url", "login_url", "access_url", "panel_url"]),
  };
}

export function planPayload(plan, orderNo, expiresAt) {
  const nat = plan.assign_nat === 1 || plan.assign_nat === true;
  return {
    name: `vps-${orderNo.toLowerCase()}`,
    virtualization: plan.virtualization,
    template_id: plan.clicd_image,
    vcpu: plan.cpu,
    ram_mb: plan.memory_mb,
    disk_gb: plan.disk_gb,
    assign_nat: nat,
    port_mapping_count: nat ? Math.max(2, Math.min(64, Number(plan.port_mapping_count || 2))) : 0,
    assign_ipv4: plan.assign_ipv4 === 1,
    ipv4_count: plan.assign_ipv4 === 1 ? 1 : 0,
    public_ipv4s: [],
    assign_ipv6: plan.assign_ipv6 === 1,
    ipv6_count: plan.assign_ipv6 === 1 ? 1 : 0,
    network_down_mbps: plan.network_down_mbps,
    network_up_mbps: plan.network_up_mbps,
    monthly_traffic_gb: plan.traffic_gb,
    expires_at: expiresAt.slice(0, 10),
    ssh_password: "",
    ssh_public_key: "",
  };
}

export async function imageCatalog(env) {
  const nodes = await clicdNodes(env);
  const output = [];
  for (const node of nodes) {
    for (const type of ["lxc", "kvm"]) {
      try {
        const result = await clicdRequest(node, "GET", "/images/enabled", undefined, { type });
        for (const image of listItems(result)) {
          const id = String(image.id || image.template_id || image.slug || "");
          if (id) output.push({ id, name: String(image.name || image.label || id), type, node: node.url, node_label: node.label, choice: `${encodeURIComponent(node.url)}|${encodeURIComponent(id)}` });
        }
      } catch (error) {
        output.push({ error: String(error.message || error), type, node: node.url, node_label: node.label });
      }
    }
  }
  return output;
}
