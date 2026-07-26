import test from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("one-click Worker config declares assets, D1, Queues, Cron, and observability", async () => {
  const config = JSON.parse(await readFile(path.join(root, "wrangler.jsonc"), "utf8"));
  assert.equal(config.main, "worker/src/index.js");
  assert.equal(config.assets.directory, "./pages/dist");
  assert.equal(config.assets.not_found_handling, "single-page-application");
  assert.deepEqual(config.assets.run_worker_first, ["/api/*", "/healthz"]);
  assert.equal(config.d1_databases[0].binding, "DB");
  assert.equal(config.d1_databases[0].migrations_dir, "worker/migrations");
  assert.equal(config.queues.producers[0].binding, "JOBS");
  assert.equal(config.queues.consumers[0].dead_letter_queue, "vps-one-dead");
  assert.deepEqual(config.triggers.crons, ["*/5 * * * *"]);
  assert.equal(config.observability.enabled, true);
});

test("Worker Assets build contains SPA, shared themes, and noVNC", async () => {
  const output = path.join(root, "pages", "dist");
  for (const item of ["index.html", "app.js", "cf.css", "assets/app.css", "assets/themes.css", "assets/ui.js", "assets/vendor/novnc/core/rfb.js"]) {
    const info = await stat(path.join(output, item));
    assert.ok(info.size > 0, item);
  }
  await assert.rejects(stat(path.join(output, "_redirects")), { code: "ENOENT" });
  const html = await readFile(path.join(output, "index.html"), "utf8");
  const app = await readFile(path.join(output, "app.js"), "utf8");
  const headers = await readFile(path.join(output, "_headers"), "utf8");
  assert.match(html, /<title>VPS-ONE<\/title>/);
  assert.match(html, /\/assets\/themes\.css/);
  assert.match(app, /state\.plans = plans\.plans \|\| \[\]/);
  assert.match(app, /data-form="bootstrap"/);
  assert.match(headers, /connect-src 'self' wss:/);
  assert.match(headers, /form-action 'self'/);
  assert.doesNotMatch(headers, /connect-src[^\n]*https:/);
  assert.doesNotMatch(headers, /max-age=3600/);
});

test("deploy template is self-contained and declares required secrets", async () => {
  for (const item of ["app.css", "themes.css", "ui.js", "vendor/novnc/core/rfb.js"]) {
    const info = await stat(path.join(root, "pages", "assets-source", item));
    assert.ok(info.size > 0, item);
  }
  const secrets = await readFile(path.join(root, ".dev.vars.example"), "utf8");
  for (const name of ["SECRET_KEY", "MASTER_KEY", "ADMIN_BOOTSTRAP_TOKEN", "RESEND_API_TOKEN", "EMAIL_FROM"]) assert.match(secrets, new RegExp(`^${name}=`, "m"));
});
