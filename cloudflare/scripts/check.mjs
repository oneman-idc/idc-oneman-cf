import { readdir } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function files(directory, suffix) {
  const result = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, item.name);
    if (item.isDirectory()) result.push(...await files(target, suffix));
    else if (target.endsWith(suffix)) result.push(target);
  }
  return result;
}

const scripts = [
  ...await files(path.join(root, "worker", "src"), ".js"),
  ...await files(path.join(root, "pages", "src"), ".js"),
  ...await files(path.join(root, "pages", "functions"), ".js"),
  ...await files(path.join(root, "scripts"), ".mjs"),
  ...await files(path.join(root, "tests"), ".cjs"),
];

for (const script of scripts) {
  const checked = spawnSync(process.execPath, ["--check", script], { stdio: "inherit" });
  if (checked.status !== 0) process.exit(checked.status || 1);
}
console.log(`Checked ${scripts.length} Cloudflare JavaScript modules`);
