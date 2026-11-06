-- Apply after 0001.sql and 0002-admin-content.sql. No network operation.
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS push_subscriptions (
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 24 AND 80),
 user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 endpoint_unique_hash TEXT NOT NULL UNIQUE CHECK(length(endpoint_unique_hash)=43),
 -- All three values are v1.<96-bit IV>.<AES-GCM ciphertext+tag>.
 -- AAD binds the ciphertext to user_id, endpoint_unique_hash and column name.
 endpoint_cipher TEXT NOT NULL CHECK(substr(endpoint_cipher,1,3)='v1.' AND length(endpoint_cipher) BETWEEN 50 AND 4096),
 p256dh TEXT NOT NULL CHECK(substr(p256dh,1,3)='v1.' AND length(p256dh) BETWEEN 50 AND 256),
 auth TEXT NOT NULL CHECK(substr(auth,1,3)='v1.' AND length(auth) BETWEEN 50 AND 160),
 created_at INTEGER NOT NULL CHECK(created_at>=0)
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id,created_at);
-- An UPSERT of an existing endpoint is allowed at the cap; ownership is immutable.
CREATE TRIGGER IF NOT EXISTS push_max_devices BEFORE INSERT ON push_subscriptions
 WHEN NOT EXISTS(SELECT 1 FROM push_subscriptions WHERE endpoint_unique_hash=NEW.endpoint_unique_hash)
  AND (SELECT count(*) FROM push_subscriptions WHERE user_id=NEW.user_id)>=5
 BEGIN SELECT RAISE(ABORT,'push_device_limit'); END;
CREATE TRIGGER IF NOT EXISTS push_identity_immutable BEFORE UPDATE OF id,user_id,endpoint_unique_hash,created_at ON push_subscriptions
 BEGIN SELECT RAISE(ABORT,'immutable_push_identity'); END;
-- Subscription lifecycle and dispatch results use the existing audit_events
-- append-only, chained INSERT-only service; ciphertexts and endpoints never enter it.
