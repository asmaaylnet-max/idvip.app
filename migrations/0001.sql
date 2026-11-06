PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
 id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('owner','principal','moderator','user')),
 public_id INTEGER NOT NULL UNIQUE, locale TEXT NOT NULL DEFAULT 'ar' CHECK(locale IN ('ar','en')),
 password_hash TEXT, status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','deleting')),
 verified_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT OR IGNORE INTO counters VALUES ('public_id',0);
CREATE TABLE IF NOT EXISTS sites (
 id TEXT PRIMARY KEY, owner_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
 slug TEXT NOT NULL UNIQUE COLLATE NOCASE, language TEXT NOT NULL CHECK(language IN ('ar','en')),
 status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','review','published','suspended','hidden')),
 draft_json TEXT NOT NULL CHECK(json_valid(draft_json)), revision INTEGER NOT NULL DEFAULT 0,
 published_json TEXT CHECK(published_json IS NULL OR json_valid(published_json)), published_revision INTEGER,
 pending_review TEXT, visible INTEGER NOT NULL DEFAULT 0 CHECK(visible IN (0,1)),
 discoverable INTEGER NOT NULL DEFAULT 0 CHECK(discoverable IN (0,1)), privacy_hidden TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(privacy_hidden)), disclosure_revision INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS slug_reservations (
 slug TEXT PRIMARY KEY COLLATE NOCASE, email TEXT NOT NULL COLLATE NOCASE, challenge_id TEXT NOT NULL UNIQUE, expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS otp_challenges (
 id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE, purpose TEXT NOT NULL CHECK(purpose IN ('signup','login','recover')),
 pin_hash TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)), attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 6),
 expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, consumed_at INTEGER, verified_user_id TEXT,
 delivery_state TEXT NOT NULL DEFAULT 'pending' CHECK(delivery_state IN ('pending','accepted','unknown','failed'))
);
CREATE INDEX IF NOT EXISTS otp_email_time ON otp_challenges(email,created_at DESC);
CREATE TABLE IF NOT EXISTS sessions (
 token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 csrf TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, auth_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS passkeys (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, public_key TEXT NOT NULL,
 counter INTEGER NOT NULL, transports TEXT NOT NULL DEFAULT '[]', device_type TEXT NOT NULL, backed_up INTEGER NOT NULL,
 created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS webauthn_challenges (
 id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('register','authenticate')),
 challenge TEXT NOT NULL, origin TEXT NOT NULL, rp_id TEXT NOT NULL, session_hash TEXT, created_at INTEGER NOT NULL,
 expires_at INTEGER NOT NULL, consumed_at INTEGER
);
CREATE TABLE IF NOT EXISTS reviews (
 id TEXT PRIMARY KEY, site_id TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE, owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 revision INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('publish','edit')), data_json TEXT NOT NULL CHECK(json_valid(data_json)),
 privacy_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(privacy_json)), disclosure_revision INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approve','reject','changes','suspend')),
 created_at INTEGER NOT NULL, decided_at INTEGER, decided_by TEXT, note TEXT NOT NULL DEFAULT '', decision_event TEXT UNIQUE
);
CREATE UNIQUE INDEX IF NOT EXISTS reviews_pending ON reviews(site_id) WHERE status='pending';
CREATE TRIGGER IF NOT EXISTS reviews_immutable BEFORE UPDATE OF id,site_id,owner_id,revision,kind,data_json,privacy_json,disclosure_revision,created_at ON reviews BEGIN SELECT RAISE(ABORT,'immutable_review'); END;
CREATE TRIGGER IF NOT EXISTS reviews_final BEFORE UPDATE OF status ON reviews WHEN OLD.status <> 'pending' BEGIN SELECT RAISE(ABORT,'review_already_decided'); END;
CREATE TABLE IF NOT EXISTS media (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, object_key TEXT NOT NULL UNIQUE,
 mime TEXT NOT NULL CHECK(mime='image/webp'), bytes INTEGER NOT NULL, width INTEGER NOT NULL, height INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), home_locked INTEGER NOT NULL DEFAULT 0 CHECK(home_locked IN (0,1)), platform_locked INTEGER NOT NULL DEFAULT 0 CHECK(platform_locked IN (0,1)), revision INTEGER NOT NULL DEFAULT 0);
INSERT OR IGNORE INTO settings(id) VALUES(1);
CREATE TABLE IF NOT EXISTS blogs (
 id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title_ar TEXT NOT NULL, title_en TEXT NOT NULL, body_ar TEXT NOT NULL,
 body_en TEXT NOT NULL, published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)), updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
 id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, title TEXT NOT NULL, body TEXT NOT NULL,
 created_at INTEGER NOT NULL, read_at INTEGER, heard_at INTEGER
);
CREATE INDEX IF NOT EXISTS notifications_user ON notifications(user_id,created_at DESC);
CREATE TABLE IF NOT EXISTS invitations (
 id TEXT PRIMARY KEY, email TEXT NOT NULL COLLATE NOCASE, role TEXT NOT NULL CHECK(role IN ('principal','moderator','user')),
 mode TEXT NOT NULL CHECK(mode IN ('moderator','managed','handover')), site_id TEXT REFERENCES sites(id) ON DELETE CASCADE,
 expected_owner_id TEXT, payload_json TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(payload_json)), invited_by TEXT NOT NULL,
 created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, accepted_at INTEGER, accepted_by TEXT
);
CREATE TABLE IF NOT EXISTS email_outbox (
 id TEXT PRIMARY KEY, to_email TEXT NOT NULL, payload_cipher TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','sending','accepted','unknown','failed')),
 provider TEXT, provider_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, uncertain INTEGER NOT NULL DEFAULT 0 CHECK(uncertain IN (0,1)), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
 next_attempt_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, lease_until INTEGER, last_code TEXT
);
CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, window_start INTEGER NOT NULL, count INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS deletion_jobs (id TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE, object_keys TEXT NOT NULL CHECK(json_valid(object_keys)), created_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS audit_events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, actor TEXT NOT NULL, action TEXT NOT NULL, object TEXT NOT NULL,
 outcome TEXT NOT NULL, created_at INTEGER NOT NULL, prev_hash TEXT NOT NULL, hash TEXT NOT NULL UNIQUE
);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON audit_events BEGIN SELECT RAISE(ABORT,'append_only_audit'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON audit_events BEGIN SELECT RAISE(ABORT,'append_only_audit'); END;
CREATE TRIGGER IF NOT EXISTS audit_chain BEFORE INSERT ON audit_events WHEN NEW.prev_hash <> COALESCE((SELECT hash FROM audit_events ORDER BY seq DESC LIMIT 1),'GENESIS') BEGIN SELECT RAISE(ABORT,'audit_chain_conflict'); END;
CREATE INDEX IF NOT EXISTS audit_time ON audit_events(created_at DESC);
