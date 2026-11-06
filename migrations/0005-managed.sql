PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS custody (
 user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
 admin_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS custody_admin ON custody(admin_id,created_at);
CREATE TRIGGER IF NOT EXISTS custody_unverified_insert BEFORE INSERT ON custody
WHEN NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.user_id AND role='user' AND status='active' AND COALESCE(verified_at,0)=0)
 OR NOT EXISTS(SELECT 1 FROM users WHERE id=NEW.admin_id AND status='active' AND role IN ('owner','principal'))
BEGIN SELECT RAISE(ABORT,'custody_requires_unverified_user_and_root'); END;
CREATE TRIGGER IF NOT EXISTS custody_no_reassign BEFORE UPDATE ON custody
BEGIN SELECT RAISE(ABORT,'custody_immutable'); END;
