import baseSchema from "../../migrations/0001_schema.sql";
import { applyDatabaseSchema } from "./schema-core.js";

const ready = new WeakMap();

export async function ensureSchema(env) {
  if (!env.DB) throw new Error("D1 binding DB is not configured");
  let promise = ready.get(env.DB);
  if (!promise) {
    promise = applyDatabaseSchema(env.DB, baseSchema).catch((error) => {
      ready.delete(env.DB);
      throw error;
    });
    ready.set(env.DB, promise);
  }
  await promise;
}
