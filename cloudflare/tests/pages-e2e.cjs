const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "../..");
const artifacts = path.join(root, "cloudflare", "tests", "artifacts");
const port = Number(process.env.CF_E2E_PORT || 19086);
const baseURL = `http://127.0.0.1:${port}`;

function browserLaunchOptions() {
  const windowsCandidates = process.platform === "win32" ? [
    path.join(process.env["PROGRAMFILES(X86)"] || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.PROGRAMFILES || "", "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(process.env.PROGRAMFILES || "", "Google", "Chrome", "Application", "chrome.exe"),
  ] : [];
  const unixCandidates = process.platform === "win32" ? [] : [
    "/usr/bin/microsoft-edge",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
  ];
  const executablePath = [process.env.PLAYWRIGHT_EXECUTABLE_PATH, ...windowsCandidates, ...unixCandidates]
    .filter(Boolean)
    .find((candidate) => fs.existsSync(candidate));
  return executablePath ? { headless: true, executablePath } : { headless: true };
}

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Preview server did not start")), 10000);
    child.stdout.on("data", (chunk) => {
      if (String(chunk).includes("CF preview ready")) { clearTimeout(timer); resolve(); }
    });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.once("exit", (code) => { clearTimeout(timer); if (code) reject(new Error(`Preview server exited with ${code}`)); });
  });
}

async function noHorizontalOverflow(page) {
  const sizes = await page.evaluate(() => ({ body: document.body.scrollWidth, root: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
  assert.ok(Math.max(sizes.body, sizes.root) <= sizes.viewport + 1, `horizontal overflow: ${JSON.stringify(sizes)}`);
}

async function nonBlank(page) {
  const sample = await page.evaluate(() => {
    const points = [[2, 2], [innerWidth / 2, 80], [innerWidth / 2, innerHeight / 2], [innerWidth - 2, innerHeight - 2]];
    return points.map(([x, y]) => {
      const element = document.elementFromPoint(Math.max(0, x), Math.max(0, y));
      return element ? `${element.tagName}:${getComputedStyle(element).backgroundColor}:${getComputedStyle(element).color}` : "none";
    });
  });
  assert.ok(new Set(sample).size > 1, `page appears blank: ${sample.join("|")}`);
}

(async () => {
  fs.mkdirSync(artifacts, { recursive: true });
  const server = spawn(process.execPath, [path.join(__dirname, "mock-preview.cjs"), String(port)], { env: { ...process.env, CF_PREVIEW_PORT: String(port) }, stdio: ["ignore", "pipe", "pipe"] });
  let browser;
  try {
    await waitForServer(server);
    browser = await chromium.launch(browserLaunchOptions());
    const desktop = await browser.newContext({ viewport: { width: 1440, height: 1000 }, colorScheme: "light" });
    const page = await desktop.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
    await page.goto(`${baseURL}/#store`, { waitUntil: "networkidle" });
    await page.locator(".cf-card").first().waitFor();
    assert.equal(await page.locator(".cf-card").count(), 2);
    assert.ok(await page.locator(".ui-settings-trigger").isVisible());
    await noHorizontalOverflow(page);
    await nonBlank(page);
    await page.screenshot({ path: path.join(artifacts, "default-store-desktop.png"), fullPage: true });

    await page.locator('[data-target="dashboard"]').click();
    await page.getByRole("heading", { name: "我的云主机" }).waitFor();
    assert.ok(await page.getByRole("button", { name: "VNC", exact: true }).isVisible());
    await page.getByRole("button", { name: "详细", exact: true }).click();
    await page.getByText("Preview-Only-Password").waitFor();
    await page.screenshot({ path: path.join(artifacts, "complete-container-details.png"), fullPage: true });

    const pendingPage = await desktop.newPage();
    await pendingPage.route("**/api/account", async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.instances[0] = { ...data.instances[0], details_state: "pending", details_error: "ipv4,ssh_password", missing_details: ["ipv4", "ssh_password"], ip: "" };
      data.orders[0] = { ...data.orders[0], status: "provisioning" };
      await route.fulfill({ response, json: data });
    });
    await pendingPage.goto(`${baseURL}/#dashboard`, { waitUntil: "networkidle" });
    await pendingPage.getByText("正在核对容器完整信息").waitFor();
    assert.equal(await pendingPage.getByRole("button", { name: "详情同步中" }).isDisabled(), true);
    assert.equal(await pendingPage.getByRole("button", { name: "VNC", exact: true }).count(), 0);
    await noHorizontalOverflow(pendingPage);
    await pendingPage.screenshot({ path: path.join(artifacts, "pending-container-details.png"), fullPage: true });
    await pendingPage.close();

    await page.locator(".ui-settings-trigger").click();
    await page.locator('[data-ui-setting="skin"][data-ui-value="newskin"]').click();
    await page.locator('[data-ui-setting="mode"][data-ui-value="dark"]').click();
    await page.locator('[data-ui-setting="language"][data-ui-value="en"]').click();
    assert.equal(await page.locator("html").getAttribute("data-skin"), "newskin");
    assert.equal(await page.locator("html").getAttribute("data-color"), "dark");
    await page.getByRole("heading", { name: "My cloud servers" }).waitFor();

    await page.locator('[data-target="admin"]').click();
    await page.getByRole("heading", { name: "Admin workspace" }).waitFor();
    await page.getByRole("button", { name: "Plans", exact: true }).click();
    await page.locator('[data-form="admin-plan"] select[name="clicd_choice"]').waitFor();
    const choice = page.locator('[data-form="admin-plan"] select[name="clicd_choice"]');
    assert.equal(await choice.locator('option[data-type="lxc"]:not([disabled])').count(), 2);
    assert.equal(await choice.locator('option[data-type="kvm"]:not([disabled])').count(), 0);
    await page.locator('[data-form="admin-plan"] select[name="virtualization"]').selectOption("kvm");
    assert.equal(await choice.locator('option[data-type="lxc"]:not([disabled])').count(), 0);
    assert.equal(await choice.locator('option[data-type="kvm"]:not([disabled])').count(), 1);
    assert.equal(await page.locator('[data-form="admin-plan"] input[name="port_mapping_count"]').inputValue(), "2");
    await page.screenshot({ path: path.join(artifacts, "newskin-dark-admin-plans.png"), fullPage: true });
    assert.deepEqual(errors, []);
    await desktop.close();

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: "dark" });
    await mobile.addInitScript(() => {
      localStorage.setItem("vps-one-ui", JSON.stringify({ skin: "glass", mode: "dark", language: "zh-CN" }));
    });
    const mobilePage = await mobile.newPage();
    const mobileErrors = [];
    mobilePage.on("pageerror", (error) => mobileErrors.push(error.message));
    mobilePage.on("console", (message) => { if (message.type() === "error") mobileErrors.push(message.text()); });
    await mobilePage.goto(`${baseURL}/#account`, { waitUntil: "networkidle" });
    await mobilePage.getByRole("heading", { name: /qmxkzp/i }).waitFor();
    assert.equal(await mobilePage.locator("html").getAttribute("data-skin"), "glass");
    await noHorizontalOverflow(mobilePage);
    await nonBlank(mobilePage);
    await mobilePage.screenshot({ path: path.join(artifacts, "glass-dark-account-mobile.png"), fullPage: true });
    assert.deepEqual(mobileErrors, []);
    await mobile.close();
    process.stdout.write(`Cloudflare Pages E2E passed; screenshots: ${artifacts}\n`);
  } finally {
    if (browser) await browser.close();
    server.kill("SIGTERM");
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
