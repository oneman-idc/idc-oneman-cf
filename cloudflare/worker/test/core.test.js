import test from "node:test";
import assert from "node:assert/strict";
import { confirmationHash, hashPassword, open, seal, verifyPassword } from "../src/lib/crypto.js";
import { accessDetails, clicdRequest, containerDetails, normalizeClicdUrl, planPayload } from "../src/lib/clicd.js";
import { allowedOrigins, corsHeaders, originAllowed } from "../src/lib/cors.js";
import { completeAccessDetails, deliveryReport, mergeInstanceDetails, needsInstanceSync } from "../src/lib/instances.js";
import { sendMail } from "../src/lib/mail.js";
import { fromBase64Url, randomLetters, randomToken, route } from "../src/lib/util.js";

test("password hashing and encrypted values round-trip in Workers WebCrypto", async () => {
  const secretKey = "worker-secret-key-for-password-pepper";
  const encoded = await hashPassword("StrongPassword123", secretKey);
  assert.match(encoded, /^pbkdf2_sha256_peppered\$210000\$[A-Za-z0-9_-]+\$[A-Za-z0-9_-]+$/);
  assert.equal(await verifyPassword(encoded, "StrongPassword123", secretKey), true);
  assert.equal(await verifyPassword(encoded, "WrongPassword123", secretKey), false);
  assert.equal(await verifyPassword(encoded, "StrongPassword123", "different-secret-key"), false);
  const legacy = "pbkdf2_sha256$100000$MDEyMzQ1Njc4OWFiY2RlZg$y6OFZ78DjCMduoyhMsmc3KWH6jWNCcIk0thrgPIRoAM";
  assert.equal(await verifyPassword(legacy, "LegacyPassword123", secretKey), true);
  const encrypted = await seal(JSON.stringify({ token: "secret" }), "master-key-for-test");
  assert.equal(encrypted.includes("secret"), false);
  assert.deepEqual(JSON.parse(await open(encrypted, "master-key-for-test")), { token: "secret" });
  assert.equal(await confirmationHash("RF1", "123456", "key"), await confirmationHash("RF1", "123456", "key"));
});

test("opaque identifiers use URL-safe values", () => {
  const token = randomToken(32);
  assert.match(token, /^[A-Za-z0-9_-]+$/);
  assert.equal(fromBase64Url(token).length, 32);
  assert.match(randomLetters(6), /^[a-z]{6}$/);
  assert.deepEqual(route("/api/instances/42/access", /^\/api\/instances\/(\d+)\/access$/), ["42"]);
});

test("CLICD plan payload preserves NAT count and runtime contract", () => {
  const plan = { virtualization: "kvm", clicd_image: "debian", cpu: 2, memory_mb: 2048, disk_gb: 40, assign_nat: 1, port_mapping_count: 8, assign_ipv4: 0, assign_ipv6: 1, network_down_mbps: 200, network_up_mbps: 100, traffic_gb: 1000 };
  const payload = planPayload(plan, "CF123", "2099-01-02T00:00:00.000Z");
  assert.equal(payload.template_id, "debian");
  assert.equal(payload.port_mapping_count, 8);
  assert.equal(payload.expires_at, "2099-01-02");
  plan.assign_nat = 0;
  assert.equal(planPayload(plan, "CF124", "2099-01-02").port_mapping_count, 0);
});

test("CLICD request uses the V5 API contract", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init };
    return new Response(JSON.stringify({ success: true, data: { id: "ct-1" } }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  try {
    const result = await clicdRequest({ url: "https://panel.example.com", token: "key" }, "GET", "/containers/ct-1", undefined, { type: "kvm" });
    assert.equal(result.data.id, "ct-1");
    assert.equal(captured.url, "https://panel.example.com/api/v1/containers/ct-1?type=kvm");
    assert.equal(captured.init.headers["X-API-Key"], "key");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(containerDetails({ data: { container: { uuid: "ct-1", state: "running", network: { ipv4: "192.0.2.2", ssh_port: 2222 } } } }), {
    id: "ct-1", name: "", status: "running", ip: "192.0.2.2", ipv6: "", ssh_port: 2222, ssh_password: "", username: "", access_code: "", management_url: "",
  });
});

test("CLICD details normalize nested access and NAT port mappings", () => {
  const details = containerDetails({ success: true, data: { container: {
    uuid: "ct-2", hostname: "demo", power_status: "online",
    network: { public_ipv4s: [{ address: "198.51.100.8/24" }], ipv6_addresses: ["2001:db8::8/64"], port_mappings: [{ container_port: 22, host_port: 30222 }] },
  }, sub_user: { username: "user-demo", initial_password: "secret", access_code: "code-1", login_url: "http://panel.example.test/login?code=code-1" } } });
  assert.equal(details.ip, "198.51.100.8");
  assert.equal(details.ipv6, "2001:db8::8");
  assert.equal(details.ssh_port, 30222);
  assert.equal(details.status, "running");
  assert.equal(details.username, "");
  assert.equal(details.ssh_password, "");
  assert.deepEqual(accessDetails({ success: true, data: { sub_user: { username: "user-demo", initial_password: "secret", access_code: "code-1", login_url: "http://panel.example.test/login?code=code-1" } } }), {
    username: "user-demo", password: "secret", access_code: "code-1", management_url: "http://panel.example.test/login?code=code-1",
  });
  assert.deepEqual(accessDetails({ data: { subUserInfo: { userName: "camel-user", initialPassword: "camel-secret", accessCode: "camel-code", loginUrl: "https://panel.example.test/login" } } }), {
    username: "camel-user", password: "camel-secret", access_code: "camel-code", management_url: "https://panel.example.test/login",
  });
});

test("CLICD configuration accepts HTTP and preserves non-empty instance details", () => {
  assert.equal(normalizeClicdUrl("http://panel.example.test/", 422), "http://panel.example.test");
  assert.equal(normalizeClicdUrl("https://panel.example.test", 422), "https://panel.example.test");
  assert.throws(() => normalizeClicdUrl("ftp://panel.example.test", 422));
  assert.throws(() => normalizeClicdUrl("https://user:secret@panel.example.test", 422));
  assert.throws(() => normalizeClicdUrl("https://panel.example.test?token=secret", 422));
  assert.equal(completeAccessDetails({ access_code: "code 1" }, "http://panel.example.test/").management_url, "http://panel.example.test/login?code=code%201");
  assert.deepEqual(mergeInstanceDetails({ ip: "198.51.100.1", status: "running", ssh_port: 30222 }, { ip: "", status: "unknown", ssh_port: 0, ipv6: "2001:db8::1" }), { ip: "198.51.100.1", status: "running", ssh_port: 30222, ipv6: "2001:db8::1" });
  assert.equal(needsInstanceSync({ status: "running", assign_ipv4: 1, ip: "", last_synced_at: new Date().toISOString() }), true);
});

test("a cloud order is deliverable only when all required container details are present", () => {
  const instance = {
    clicd_id: "ct-1", clicd_node: "http://panel.example.test", remote_name: "vps-cf1", expires_at: "2099-01-01",
    status: "running", assign_nat: 1, assign_ipv4: 0, assign_ipv6: 1, ip: "198.51.100.2", ipv6: "2001:db8::2", ssh_port: 30222,
  };
  const access = { ssh_username: "root", ssh_password: "ssh-secret", username: "customer", password: "panel-secret", access_code: "code-1", management_url: "http://panel.example.test/login?code=code-1" };
  assert.deepEqual(deliveryReport(instance, access), { complete: true, missing: [] });
  const incomplete = deliveryReport({ ...instance, ip: "" }, { ...access, password: "" });
  assert.equal(incomplete.complete, false);
  assert.deepEqual(incomplete.missing, ["ipv4", "management_password"]);
});

test("CORS normalizes configured origins without allowing wildcards", () => {
  const request = new Request("https://worker.example.com/api/account", { headers: { Origin: "https://app.example.com" } });
  const env = { ALLOWED_ORIGINS: "https://app.example.com/,*,not-a-url", PAGES_ORIGIN: "" };
  assert.deepEqual([...allowedOrigins(request, env)].sort(), ["https://app.example.com", "https://worker.example.com"]);
  assert.equal(originAllowed(request, env), true);
  assert.equal(corsHeaders(request, env)["Access-Control-Allow-Origin"], "https://app.example.com");
  assert.equal(originAllowed(new Request(request.url, { headers: { Origin: "https://evil.example" } }), env), false);
});

test("Resend delivery uses a stable idempotency key and verified endpoint", async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, init) => {
    captured = { url: String(url), init, body: JSON.parse(init.body) };
    return new Response(JSON.stringify({ id: "email-1" }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const env = {
    RESEND_API_TOKEN: "re_test_token",
    EMAIL_FROM: "VPS-ONE <noreply@example.com>",
    DB: { prepare: () => ({ bind: () => ({ first: async () => null }) }) },
  };
  try {
    assert.deepEqual(await sendMail(env, "user@example.com", "Delivery", "Ready", { idempotencyKey: "mail_instance:12:initial" }), { id: "email-1" });
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(captured.url, "https://api.resend.com/emails");
  assert.equal(captured.init.headers.Authorization, "Bearer re_test_token");
  assert.equal(captured.init.headers["Idempotency-Key"], "mail_instance:12:initial");
  assert.deepEqual(captured.body.to, ["user@example.com"]);
});
