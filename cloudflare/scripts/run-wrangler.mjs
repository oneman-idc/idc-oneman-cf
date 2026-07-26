import { mkdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const state = path.join(root, ".wrangler");
mkdirSync(path.join(state, "config"), { recursive: true });
mkdirSync(path.join(state, "logs"), { recursive: true });

const result = spawnSync(process.execPath, [
  path.join(root, "node_modules", "wrangler", "bin", "wrangler.js"),
  ...process.argv.slice(2),
], {
  cwd: root,
  stdio: "inherit",
  env: {
    ...process.env,
    XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || path.join(state, "config"),
    WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH || path.join(state, "logs", "wrangler.log"),
    WRANGLER_SEND_METRICS: process.env.WRANGLER_SEND_METRICS || "false",
  },
});

process.exit(result.status ?? 1);
