import { cp, mkdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pages = path.join(root, "pages");
const source = path.join(pages, "src");
const output = path.join(pages, "dist");
const assets = path.join(output, "assets");
const assetsSource = path.join(pages, "assets-source");

await rm(output, { recursive: true, force: true });
await mkdir(assets, { recursive: true });
await cp(source, output, { recursive: true });
await cp(assetsSource, assets, { recursive: true });
console.log(`Cloudflare Worker assets built at ${output}`);
