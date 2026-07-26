import { getSettings } from "../lib/db.js";
import { json } from "../lib/util.js";

export async function config(_request, env) {
  const site = await getSettings(env, ["site_name", "site_tagline", "site_footer", "site_url"]);
  const users = await env.DB.prepare("SELECT COUNT(*) count FROM users").first();
  return json({ ok: true, site, initialized: Number(users?.count || 0) > 0, runtime: "cloudflare-workers-d1", version: "1.0.0" });
}

export async function plans(_request, env) {
  const rows = await env.DB.prepare(`SELECT id, name, slug, description, product_type, card_delivery_note, price_cents, currency, months,
    stock, virtualization, cpu, memory_mb, disk_gb, traffic_gb, network_down_mbps, network_up_mbps,
    assign_nat, port_mapping_count, assign_ipv4, assign_ipv6
    FROM plans WHERE active = 1 AND stock != 0 ORDER BY sort_order, id`).all();
  return json({ ok: true, plans: rows.results || [] });
}
