import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const databaseId = process.env.CF_D1_DATABASE_ID;
if (!databaseId || !/^[0-9a-f-]{36}$/i.test(databaseId)) throw new Error("CF_D1_DATABASE_ID must be a D1 database UUID");
const pagesOrigin = process.env.CF_PAGES_ORIGIN || "https://vps-one-cf-beta.pages.dev";
new URL(pagesOrigin);

let worker = await readFile(path.join(root, "worker", "wrangler.toml"), "utf8");
worker = worker.replace('database_id = "00000000-0000-0000-0000-000000000000"', `database_id = "${databaseId}"`);
worker = worker.replace('PAGES_ORIGIN = "https://vps-one-cf-beta.pages.dev"', `PAGES_ORIGIN = ${JSON.stringify(pagesOrigin)}`);
const pages = await readFile(path.join(root, "pages", "wrangler.toml"), "utf8");
await writeFile(path.join(root, "worker", "wrangler.generated.toml"), worker, "utf8");
await writeFile(path.join(root, "pages", "wrangler.generated.toml"), pages, "utf8");
console.log("Generated account-specific Wrangler configs beside each Cloudflare project");
