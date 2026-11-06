-- Apply after 0001.sql, before enabling the phase-2 routes.
-- Fixed names remain authoritative in security.RESERVED_SLUGS/validSlug;
-- they are not editable rows in this custom inventory.
CREATE TABLE IF NOT EXISTS reserved_names (
 slug TEXT PRIMARY KEY COLLATE NOCASE
  CHECK(length(slug) BETWEEN 1 AND 63 AND slug=lower(slug)
   AND slug NOT GLOB '*[^a-z0-9-]*' AND substr(slug,1,1) GLOB '[a-z0-9]'
   AND substr(slug,-1,1) GLOB '[a-z0-9]' AND substr(slug,1,4)<>'xn--'),
 type TEXT NOT NULL DEFAULT 'custom' CHECK(length(trim(type)) BETWEEN 1 AND 40 AND type<>'fixed_reserved'),
 reason TEXT NOT NULL DEFAULT '' CHECK(length(reason)<=500),
 updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS features (
 id TEXT PRIMARY KEY CHECK(length(id) BETWEEN 1 AND 80),
 sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order BETWEEN 0 AND 9999),
 title_ar TEXT NOT NULL CHECK(length(trim(title_ar)) BETWEEN 1 AND 300),
 title_en TEXT NOT NULL CHECK(length(trim(title_en)) BETWEEN 1 AND 300),
 body_ar TEXT NOT NULL CHECK(length(trim(body_ar)) BETWEEN 1 AND 6000),
 body_en TEXT NOT NULL CHECK(length(trim(body_en)) BETWEEN 1 AND 6000),
 published INTEGER NOT NULL DEFAULT 0 CHECK(published IN (0,1)),
 updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS features_public_order ON features(published,sort_order,id);
-- Existing notifications keep the ordinary in-app tone; no Push infrastructure.
ALTER TABLE notifications ADD COLUMN type TEXT NOT NULL DEFAULT 'normal' CHECK(type IN ('normal','special'));
