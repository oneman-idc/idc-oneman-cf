import { open, seal, sha256Hex } from "../lib/crypto.js";
import { clicdNodes, clicdRequest, findNode, unwrap } from "../lib/clicd.js";
import { requireCsrf, requireUser } from "../lib/db.js";
import { assert, futureIso, json, randomToken } from "../lib/util.js";

export async function createVncSession(request, env, instanceId) {
  const user = await requireUser(request, env);
  requireCsrf(request, user);
  const instance = await env.DB.prepare(`SELECT i.*, p.virtualization FROM instances i JOIN plans p ON p.id = i.plan_id
    WHERE i.id = ? AND i.user_id = ? AND i.status != 'deleted'`).bind(instanceId, user.id).first();
  assert(instance?.clicd_id && String(instance.virtualization).toLowerCase() === "kvm", 404, "vnc_unavailable", "VNC is available only for delivered KVM instances");
  const node = findNode(await clicdNodes(env), instance.clicd_node);
  const details = unwrap(await clicdRequest(node, "GET", `/containers/${encodeURIComponent(instance.clicd_id)}`)) || {};
  const containerName = String(details.name || details.hostname || instance.name);
  const ticketResult = unwrap(await clicdRequest(node, "POST", "/vnc-ticket", { container_name: containerName })) || {};
  const ticket = String(ticketResult.ticket || "");
  assert(ticket, 502, "vnc_ticket_missing", "CLICD did not return a VNC ticket");
  const token = randomToken(32);
  await env.DB.prepare("INSERT INTO vnc_sessions(token_hash, user_id, instance_id, clicd_node, container_name, clicd_ticket, expires_at) VALUES(?, ?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), user.id, instanceId, node.url, containerName, await seal(ticket, env.MASTER_KEY), futureIso(90_000)).run();
  return json({ ok: true, websocket_url: `/api/instances/${instanceId}/vnc?session=${encodeURIComponent(token)}`, instance: instance.name });
}

function closeBoth(left, right, code = 1000, reason = "closed") {
  try { left.close(code, reason); } catch {}
  try { right.close(code, reason); } catch {}
}

export async function proxyVnc(request, env, instanceId) {
  assert((request.headers.get("Upgrade") || "").toLowerCase() === "websocket", 426, "websocket_required", "WebSocket upgrade is required");
  const user = await requireUser(request, env);
  const token = new URL(request.url).searchParams.get("session") || "";
  const tokenHash = await sha256Hex(token);
  const pending = await env.DB.prepare("SELECT * FROM vnc_sessions WHERE token_hash = ? AND user_id = ? AND instance_id = ? AND expires_at > CURRENT_TIMESTAMP")
    .bind(tokenHash, user.id, instanceId).first();
  assert(pending, 401, "vnc_session_invalid", "VNC session is invalid or expired");
  await env.DB.prepare("DELETE FROM vnc_sessions WHERE token_hash = ?").bind(tokenHash).run();
  const node = findNode(await clicdNodes(env), pending.clicd_node);
  const upstreamUrl = new URL(node.url);
  upstreamUrl.protocol = upstreamUrl.protocol === "https:" ? "wss:" : "ws:";
  upstreamUrl.pathname = `${upstreamUrl.pathname.replace(/\/$/, "")}/api/vnc`;
  upstreamUrl.search = new URLSearchParams({ container: pending.container_name }).toString();
  const ticket = await open(pending.clicd_ticket, env.MASTER_KEY);
  const upstreamResponse = await fetch(upstreamUrl, {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `binary, clicd-vnc-ticket.${ticket}` },
  });
  const upstream = upstreamResponse.webSocket;
  assert(upstream, 502, "vnc_upstream_failed", `CLICD VNC WebSocket failed (${upstreamResponse.status})`);
  upstream.accept();
  const pair = new WebSocketPair();
  const browser = pair[0];
  const worker = pair[1];
  worker.accept();
  worker.addEventListener("message", (event) => upstream.send(event.data));
  upstream.addEventListener("message", (event) => worker.send(event.data));
  worker.addEventListener("close", (event) => closeBoth(worker, upstream, event.code, event.reason));
  upstream.addEventListener("close", (event) => closeBoth(worker, upstream, event.code, event.reason));
  worker.addEventListener("error", () => closeBoth(worker, upstream, 1011, "browser websocket error"));
  upstream.addEventListener("error", () => closeBoth(worker, upstream, 1011, "upstream websocket error"));
  return new Response(null, { status: 101, webSocket: browser, headers: { "Sec-WebSocket-Protocol": "binary" } });
}
