ALTER TABLE instances ADD COLUMN remote_name TEXT NOT NULL DEFAULT '';
ALTER TABLE instances ADD COLUMN details_state TEXT NOT NULL DEFAULT 'pending' CHECK(details_state IN ('pending', 'complete'));
ALTER TABLE instances ADD COLUMN details_error TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS ix_instances_delivery_state ON instances(details_state, id);
