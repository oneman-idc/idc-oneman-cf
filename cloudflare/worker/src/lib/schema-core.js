export const requiredTables = [
  "users", "sessions", "settings", "plans", "orders", "wallets", "wallet_entries", "wallet_topups",
  "card_items", "instances", "refund_requests", "payment_events", "jobs", "vnc_sessions", "audit_logs", "rate_limits",
];

const deliveryColumns = {
  remote_name: "ALTER TABLE instances ADD COLUMN remote_name TEXT NOT NULL DEFAULT ''",
  details_state: "ALTER TABLE instances ADD COLUMN details_state TEXT NOT NULL DEFAULT 'pending' CHECK(details_state IN ('pending', 'complete'))",
  details_error: "ALTER TABLE instances ADD COLUMN details_error TEXT NOT NULL DEFAULT ''",
};

async function tableCount(db) {
  const placeholders = requiredTables.map(() => "?").join(",");
  const row = await db.prepare(`SELECT COUNT(*) count FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`)
    .bind(...requiredTables).first();
  return Number(row?.count || 0);
}

export async function applyDatabaseSchema(db, baseSchema) {
  if (await tableCount(db) !== requiredTables.length) await db.exec(baseSchema);

  const columns = await db.prepare("PRAGMA table_info(instances)").all();
  const existing = new Set((columns.results || []).map((column) => column.name));
  const missing = Object.entries(deliveryColumns).filter(([name]) => !existing.has(name));
  for (const [, sql] of missing) {
    try {
      await db.prepare(sql).run();
    } catch (error) {
      if (!/duplicate column name/i.test(String(error))) throw error;
    }
  }
  await db.prepare("CREATE INDEX IF NOT EXISTS ix_instances_delivery_state ON instances(details_state, id)").run();
}
