from pathlib import Path
import sqlite3


root = Path(__file__).resolve().parents[1]
database = sqlite3.connect(":memory:")
for migration in sorted((root / "worker" / "migrations").glob("*.sql")):
    database.executescript(migration.read_text(encoding="utf-8"))

tables = {row[0] for row in database.execute("SELECT name FROM sqlite_master WHERE type='table'")}
required = {
    "users", "sessions", "settings", "plans", "orders", "wallets", "wallet_entries",
    "wallet_topups", "card_items", "instances", "refund_requests", "payment_events",
    "jobs", "vnc_sessions", "audit_logs", "rate_limits",
}
missing = required - tables
if missing:
    raise SystemExit(f"missing D1 tables: {sorted(missing)}")

seeded = dict(database.execute("SELECT key, value FROM settings"))
if seeded.get("site_name") != "VPS-ONE":
    raise SystemExit("site settings were not seeded")
if seeded.get("clicd_nodes_json") != "":
    raise SystemExit("encrypted CLICD setting must start empty")

database.execute("INSERT INTO users(username,email,password_hash) VALUES('abcdef','user@example.com','hash')")
database.execute("INSERT INTO wallets(user_id,currency,balance_cents) VALUES(1,'CNY',10000)")
database.execute("INSERT INTO plans(name,slug,price_cents,cpu,memory_mb,disk_gb) VALUES('Test','test',1000,1,512,10)")
instance_columns = {row[1] for row in database.execute("PRAGMA table_info(instances)")}
if not {"remote_name", "details_state", "details_error"}.issubset(instance_columns):
    raise SystemExit("instance delivery contract columns are missing")
database.commit()
print(f"D1 schema check passed: {len(required)} required tables")
