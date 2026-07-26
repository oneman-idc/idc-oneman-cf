PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE CHECK(length(username) = 6),
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  is_admin INTEGER NOT NULL DEFAULT 0 CHECK(is_admin IN (0, 1)),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK(is_active IN (0, 1)),
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_users_email ON users(email);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS ix_sessions_expiry ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  encrypted INTEGER NOT NULL DEFAULT 0 CHECK(encrypted IN (0, 1)),
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  product_type TEXT NOT NULL DEFAULT 'cloud' CHECK(product_type IN ('cloud', 'card')),
  card_delivery_note TEXT NOT NULL DEFAULT '',
  price_cents INTEGER NOT NULL CHECK(price_cents > 0),
  currency TEXT NOT NULL DEFAULT 'CNY',
  months INTEGER NOT NULL DEFAULT 1 CHECK(months BETWEEN 1 AND 120),
  stock INTEGER NOT NULL DEFAULT -1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  virtualization TEXT NOT NULL DEFAULT 'lxc' CHECK(virtualization IN ('lxc', 'kvm')),
  cpu INTEGER NOT NULL DEFAULT 1,
  memory_mb INTEGER NOT NULL DEFAULT 512,
  disk_gb INTEGER NOT NULL DEFAULT 10,
  traffic_gb INTEGER NOT NULL DEFAULT 0,
  network_down_mbps INTEGER NOT NULL DEFAULT 100,
  network_up_mbps INTEGER NOT NULL DEFAULT 50,
  clicd_node TEXT NOT NULL DEFAULT '',
  clicd_image TEXT NOT NULL DEFAULT '',
  clicd_template_name TEXT NOT NULL DEFAULT '',
  assign_nat INTEGER NOT NULL DEFAULT 1 CHECK(assign_nat IN (0, 1)),
  port_mapping_count INTEGER NOT NULL DEFAULT 2 CHECK(port_mapping_count BETWEEN 0 AND 64),
  assign_ipv4 INTEGER NOT NULL DEFAULT 0 CHECK(assign_ipv4 IN (0, 1)),
  assign_ipv6 INTEGER NOT NULL DEFAULT 1 CHECK(assign_ipv6 IN (0, 1)),
  active INTEGER NOT NULL DEFAULT 0 CHECK(active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_plans_active_sort ON plans(active, sort_order, id);

CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_no TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  plan_snapshot TEXT NOT NULL DEFAULT '{}',
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  currency TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  product_type TEXT NOT NULL CHECK(product_type IN ('cloud', 'card')),
  payment_method TEXT NOT NULL CHECK(payment_method IN ('hashpay', 'wallet')),
  hashpay_id TEXT UNIQUE,
  checkout_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT,
  fulfilled_at TEXT
);
CREATE INDEX IF NOT EXISTS ix_orders_user_status ON orders(user_id, status, id DESC);

CREATE TABLE IF NOT EXISTS wallets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  currency TEXT NOT NULL DEFAULT 'CNY',
  balance_cents INTEGER NOT NULL DEFAULT 0 CHECK(balance_cents >= 0),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS wallet_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_no TEXT NOT NULL UNIQUE,
  wallet_id INTEGER NOT NULL REFERENCES wallets(id),
  kind TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK(amount_cents != 0),
  balance_after_cents INTEGER NOT NULL CHECK(balance_after_cents >= 0),
  reference_type TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(wallet_id, kind, reference_type, reference_id)
);
CREATE INDEX IF NOT EXISTS ix_wallet_entries_wallet ON wallet_entries(wallet_id, id DESC);

CREATE TABLE IF NOT EXISTS wallet_topups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topup_no TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id),
  wallet_id INTEGER NOT NULL REFERENCES wallets(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'CNY',
  status TEXT NOT NULL DEFAULT 'pending',
  hashpay_id TEXT UNIQUE,
  checkout_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  paid_at TEXT
);

CREATE TABLE IF NOT EXISTS card_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  order_id INTEGER UNIQUE REFERENCES orders(id),
  secret_ciphertext TEXT NOT NULL,
  secret_fingerprint TEXT NOT NULL,
  masked_value TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available' CHECK(status IN ('available', 'assigned', 'delivered', 'disabled')),
  assigned_at TEXT,
  delivered_at TEXT,
  email_sent_at TEXT,
  email_attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(plan_id, secret_fingerprint)
);
CREATE INDEX IF NOT EXISTS ix_card_items_plan_status ON card_items(plan_id, status, id);

CREATE TABLE IF NOT EXISTS instances (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  order_id INTEGER NOT NULL UNIQUE REFERENCES orders(id),
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  clicd_id TEXT,
  clicd_node TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  remote_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'provisioning',
  details_state TEXT NOT NULL DEFAULT 'pending' CHECK(details_state IN ('pending', 'complete')),
  details_error TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  ipv6 TEXT NOT NULL DEFAULT '',
  ssh_port INTEGER NOT NULL DEFAULT 22,
  access_ciphertext TEXT NOT NULL DEFAULT '',
  expires_at TEXT,
  last_synced_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(clicd_node, clicd_id)
);
CREATE INDEX IF NOT EXISTS ix_instances_user ON instances(user_id, id DESC);
CREATE INDEX IF NOT EXISTS ix_instances_delivery_state ON instances(details_state, id);

CREATE TABLE IF NOT EXISTS refund_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  refund_no TEXT NOT NULL UNIQUE,
  order_id INTEGER NOT NULL REFERENCES orders(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  amount_cents INTEGER NOT NULL CHECK(amount_cents > 0),
  currency TEXT NOT NULL DEFAULT 'CNY',
  status TEXT NOT NULL DEFAULT 'confirmation_pending',
  reason TEXT NOT NULL DEFAULT '',
  confirmation_hash TEXT NOT NULL DEFAULT '',
  confirmation_expires_at TEXT,
  confirmation_attempts INTEGER NOT NULL DEFAULT 0,
  email_attempts INTEGER NOT NULL DEFAULT 0,
  requested_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TEXT,
  reviewed_at TEXT,
  reviewed_by INTEGER REFERENCES users(id),
  review_note TEXT NOT NULL DEFAULT '',
  container_deleted_at TEXT,
  refunded_at TEXT,
  completed_at TEXT,
  error TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS ix_refunds_user_status ON refund_requests(user_id, status, requested_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_refunds_order ON refund_requests(order_id);

CREATE TABLE IF NOT EXISTS payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  reference_no TEXT NOT NULL,
  platform_txn_id TEXT NOT NULL DEFAULT '',
  verified INTEGER NOT NULL DEFAULT 0 CHECK(verified IN (0, 1)),
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  payload TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT '',
  run_after TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_jobs_due ON jobs(status, run_after, id);

CREATE TABLE IF NOT EXISTS vnc_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  instance_id INTEGER NOT NULL REFERENCES instances(id) ON DELETE CASCADE,
  clicd_node TEXT NOT NULL,
  container_name TEXT NOT NULL,
  clicd_ticket TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_vnc_expiry ON vnc_sessions(expires_at);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS ix_audit_action ON audit_logs(action, id DESC);

CREATE TABLE IF NOT EXISTS rate_limits (
  key TEXT NOT NULL,
  bucket INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 1,
  expires_at TEXT NOT NULL,
  PRIMARY KEY(key, bucket)
);
CREATE INDEX IF NOT EXISTS ix_rate_limits_expiry ON rate_limits(expires_at);

INSERT OR IGNORE INTO settings(key, value, encrypted) VALUES
  ('site_name', 'VPS-ONE', 0),
  ('site_tagline', 'Cloud servers and digital delivery', 0),
  ('site_footer', 'VPS-ONE', 0),
  ('site_url', '', 0),
  ('clicd_nodes_json', '', 1),
  ('hashpay_base_url', '', 0),
  ('hashpay_merchant_id', '', 0),
  ('hashpay_private_key', '', 1),
  ('resend_from', '', 0);
