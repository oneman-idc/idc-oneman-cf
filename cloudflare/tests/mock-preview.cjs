const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");

const dist = path.resolve(__dirname, "../pages/dist");
const port = Number(process.env.CF_PREVIEW_PORT || process.argv[2] || 19085);
const now = new Date();
const paidAt = new Date(now.getTime() - 60 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19);
const expiresAt = new Date(now.getTime() + 30 * 86400000).toISOString().replace("T", " ").slice(0, 19);

const user = { id: 1, username: "qmxkzp", email: "admin@example.com", is_admin: true };
const cloudPlan = {
  id: 1, name: "Edge KVM 2C4G", slug: "edge-kvm-2c4g", description: "KVM cloud server with NAT port mappings",
  product_type: "cloud", price_cents: 2999, currency: "CNY", months: 1, stock: -1, virtualization: "kvm",
  cpu: 2, memory_mb: 4096, disk_gb: 60, traffic_gb: 2048, network_down_mbps: 300, network_up_mbps: 100,
  clicd_node: "https://clicd-a.example.com", clicd_image: "win-2025", assign_nat: 1, port_mapping_count: 8,
  assign_ipv4: 1, assign_ipv6: 1, active: 1, sort_order: 10,
};
const cardPlan = {
  id: 2, name: "Developer License", slug: "developer-license", description: "Automatic digital delivery by email",
  product_type: "card", card_delivery_note: "One license per order", price_cents: 990, currency: "CNY", months: 1,
  stock: 24, virtualization: "lxc", cpu: 1, memory_mb: 512, disk_gb: 10, traffic_gb: 0,
  network_down_mbps: 100, network_up_mbps: 50, assign_nat: 0, port_mapping_count: 0, assign_ipv4: 0,
  assign_ipv6: 0, active: 1, sort_order: 20, card_available: 24, card_delivered: 6,
};
const order = {
  id: 11, order_no: "CF-20260725-A81M3D", plan_name: cloudPlan.name, product_type: "cloud", amount_cents: 2999,
  currency: "CNY", status: "fulfilled", payment_method: "wallet", created_at: paidAt, paid_at: paidAt,
};
const instance = {
  id: 21, order_id: order.id, order_no: order.order_no, plan_name: cloudPlan.name, virtualization: "kvm",
  clicd_id: "vm-21", clicd_node: "https://clicd-a.example.com", remote_name: "vps-cf-20260725-7m2k9q",
  status: "running", details_state: "complete", details_error: "", missing_details: [],
  assign_nat: 1, assign_ipv4: 0, assign_ipv6: 1,
  expires_at: expiresAt, ip: "203.0.113.24", ipv6: "2001:db8::24", ssh_port: 22022,
};

function payload(url, method) {
  const pathname = url.pathname.replace(/^\/api/, "") || "/";
  if (pathname === "/config") return { ok: true, initialized: true, runtime: "cloudflare-workers-d1", version: "1.0.0", site: { site_name: "VPS-ONE Edge", site_tagline: "边缘云主机与数字交付", site_footer: "VPS-ONE", site_url: `http://127.0.0.1:${port}` } };
  if (pathname === "/session") return { ok: true, user, csrf_token: "preview-csrf" };
  if (pathname === "/plans") return { ok: true, plans: [cloudPlan, cardPlan] };
  if (pathname === "/account") return {
    ok: true, user, csrf_token: "preview-csrf", wallet: { id: 1, balance_cents: 128800, currency: "CNY" },
    entries: [{ id: 1, created_at: paidAt, description: "Wallet top-up", amount_cents: 150000 }], topups: [],
    orders: [order, { id: 12, order_no: "CF-20260725-CARD71", plan_name: cardPlan.name, product_type: "card", amount_cents: 990, currency: "CNY", status: "fulfilled", payment_method: "hashpay", created_at: paidAt, paid_at: paidAt, masked_value: "********9X2K" }],
    instances: [instance], refunds: [],
  };
  if (pathname === `/instances/${instance.id}/access`) return { ok: true, instance, access: { ssh_username: "root", ssh_password: "Preview-SSH-Password", username: "preview-user", password: "Preview-Only-Password", access_code: "preview-code", management_url: "https://panel.example.com/login?code=preview-code" } };
  if (pathname === "/admin") return { ok: true, csrf_token: "preview-csrf", stats: { users: 18, plans: 2, orders: 42, instances: 31, pending_refunds: 1, open_jobs: 0 }, orders: [order], jobs: [] };
  if (pathname === "/admin/plans") return { ok: true, csrf_token: "preview-csrf", plans: [{ ...cloudPlan, card_available: 0, card_delivered: 0 }, cardPlan], deliveries: [] };
  if (pathname === "/admin/clicd/images") return { ok: true, images: [
    { node: "https://clicd-a.example.com", node_label: "Shanghai A", id: "ubuntu-2404", name: "Ubuntu 24.04", type: "lxc" },
    { node: "https://clicd-a.example.com", node_label: "Shanghai A", id: "win-2025", name: "Windows Server 2025", type: "kvm" },
    { node: "https://clicd-b.example.com", node_label: "Tokyo B", id: "debian-12", name: "Debian 12", type: "lxc" },
  ] };
  if (pathname === "/admin/products") return { ok: true, csrf_token: "preview-csrf", errors: [], containers: [{ id: "vm-21", uuid: "vm-21", name: "edge-kvm-21", status: "running", _node: "https://clicd-a.example.com", _node_label: "Shanghai A" }] };
  if (pathname === "/admin/refunds") return { ok: true, csrf_token: "preview-csrf", refunds: [{ id: 7, refund_no: "RF-20260725-8K1R2Q", order_no: order.order_no, username: user.username, email: user.email, status: "pending_review", reason: "Service does not match the selected region" }] };
  if (pathname === "/admin/settings") return { ok: true, csrf_token: "preview-csrf", settings: { site_name: "VPS-ONE Edge", site_tagline: "边缘云主机与数字交付", site_footer: "VPS-ONE", site_url: `http://127.0.0.1:${port}`, clicd_nodes: [{ label: "Shanghai A", url: "https://clicd-a.example.com", token_configured: true, insecure: false }, { label: "Lab HTTP", url: "http://clicd-lab.example.com", token_configured: true, insecure: true }], hashpay_base_url: "https://pay.example.com", hashpay_merchant_id: "vps-one", hashpay_private_key_configured: true, resend_api_token_configured: true, resend_from: "VPS-ONE <noreply@example.com>" } };
  if (method !== "GET") return { ok: true };
  return { error: { code: "preview_not_found", message: `No preview response for ${pathname}` } };
}

const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".svg": "image/svg+xml", ".png": "image/png", ".woff2": "font/woff2" };

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host || `127.0.0.1:${port}`}`);
    if (url.pathname.startsWith("/api/")) {
      const value = payload(url, request.method || "GET");
      response.writeHead(value.error ? 404 : 200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      return response.end(JSON.stringify(value));
    }
    const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
    const candidate = path.resolve(dist, `.${requested}`);
    const target = candidate.startsWith(`${dist}${path.sep}`) ? candidate : path.join(dist, "index.html");
    let body;
    let file = target;
    try { body = await fs.readFile(file); } catch { file = path.join(dist, "index.html"); body = await fs.readFile(file); }
    response.writeHead(200, { "Content-Type": mime[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
    response.end(body);
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(String(error.stack || error));
  }
});

server.listen(port, "127.0.0.1", () => process.stdout.write(`CF preview ready at http://127.0.0.1:${port}\n`));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
