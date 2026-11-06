# Managed / custody contract

## Parent integration (no user-owned API or session impersonation)

Mount `managedRoutes` from `src/server/routes/managed.ts` at `/admin/managed` after migration `0005-managed.sql` (no 0004 dependency). Render default `Managed` from `src/client/pages/Managed.tsx` with `{path}` for `/admin/managed` and `/admin/managed/:id`; optional `{id}` also accepted. IDs in these URLs are the actual target **user UID**, never site slug or public counter.

OTP client: `/auth/request` for existing custody login/recover returns `consentRequired: true` alongside `challengeId` (including the 503 email-unknown/unavailable response containing a challenge). The code step must show explicit account receipt consent plus terms and 18+ checkboxes, and send `/auth/verify` `{challengeId,pin,acceptCustody:true,termsAccepted:true,ageConfirmed:true}`. All three are optional for ordinary login and strictly required for custody. No public email/custody lookup endpoint exists. Missing consent after a valid PIN returns 400 `INVITATION` with `consentRequired:true` and the same challenge ID, without consuming it or granting a session. Resends use the same challenge ID. Do not expose the custodian's identity. Account UI integration is parent-owned.

Custody is temporary control of the target user's draft; it is never authentication as that user. The target is created with UUID, counter-derived public ID, role=user, verified_at=0, null password, no sessions, and a real uniquely allocated slug. Both bootstrap owner emails are prohibited. Every managed mutation rechecks live root status, custody binding and COALESCE(target.verified_at,0)=0 in its SQL transaction. OTP receipt checks custody in its audited batch, removes only custody, updates verified_at, and preserves user/site UID, draft, media and immutable review snapshots. After receipt, the old administrator cannot read private draft or mutate it via managed APIs; normal moderation remains unchanged.

Managed submission uses the existing pending reviews queue and immutable snapshot. The page offers a single submission action then native navigation to `/admin` for the existing review UI; there is no automatic approval or special bypass.

Private preview is inline and fetched only from authenticated `/admin/managed/:id/preview`; it never uses public draft, QR, export or share routes. Every internal navigation uses `u.navigate`.

## Implemented routes / payloads

- `GET /admin/managed` → `{createdFiles:[{id,name,email,publicId,siteId,slug,language,status,revision,pendingReview,createdAt}]}` for this administrator's live custody only.
- `POST /admin/managed` with `{name,email,slug,language,locale?}` → 201 `{id,site,invitationQueued:false}`. Creation is audited, rejects bootstrap owner emails and fixed/custom reserved or actively OTP-reserved labels. Actual user and site IDs are UUIDs. Existing `counters.public_id` supplies the unique public ID.
- `GET /admin/managed/:id` → `{managedUser:{id,name,email,publicId},site}`.
- `PUT /admin/managed/:id/draft` with `{data:ProfileData,revision,language?,locale?}` → `{site}`. Target-owned media, live custody and revision CAS required. Language changes are included in the same CAS.
- `GET /admin/managed/:id/preview` → `{profile:PublicProfile,revision,private:true}` with private/no-store caching.
- `POST /admin/managed/:id/submit` with `{revision,locale?}` → 201 `{reviewId,site}`. No auto-approval. Existing `reviews.owner_id` is the target actual UID; snapshot and pending-review invariants are unchanged.
- `POST /admin/managed/:id/media`: multipart `file` (WebP only) plus required `revision`; returns `{media:{id,url,width,height,bytes}}`. Uses existing WebP inspection/caps, target R2 private path and audited live-custody CAS. Client converts JPEG/PNG locally before sending; server does not accept other MIME types.
- `POST /admin/managed/:id/invite` with `{locale?}` → `{outboxId,emailAccepted,emailUnknown}`; 503 if sender acceptance is unconfirmed. The recipient locale drives the bilingual receipt message. Creation does **not** falsely claim invitation delivery. Use the explicit send button. Outbox ID is stable `managed-invite:${userId}`, and existing provider idempotency/retry behavior is reused. Encrypted payload is prepared through `enqueueEmail` then inserted in an audited batch. No direct external fetch was added.

The editor uses Field/MetalButton/Panel, all actual ProfileData fields, timeline arrays (30), language levels (0–100), skills (60), hobbies (30), portfolio/evidence (3 each), main YouTube and video links (7), links (3), all eight socials, logo/cover and draft section hiding. There is no JSON textarea. Saves serialize with revision CAS, debounce at 5 seconds, preserve edits during an in-flight save, registerNavigationGuard flushes before navigation, and beforeunload warns on unsaved changes. A conflict halts writes rather than silently replacing the latest revision. Draft hiding is not an immediate public-visibility mutation.

## Local evidence and deployment boundary

`vitest run tests/managed.test.ts`: **9 passing tests**, genuine Node SQLite + transactional D1 adapter, mock EMAIL binding, fetch forbidden. Tests cover UUID/public counter, no target sessions/password, owner-email/role/slug defenses, isolation/CAS/foreign media, immutable normal reviews, explicit consent and atomic first receipt preserving UID/site/reviews, stable audited outbox, demotion races with no phantom audit, WebP target ownership/private media read, and FK cascade.

`tsc --noEmit`: passed after the complete module and tests were added. No Git, browser, network calls, production database changes, deployed service or actual email delivery occurred. Run migration 005 before mounting these auth/helper changes. Older test adapters that only apply 0001/0002 must also apply 0005; this task intentionally did not edit their files. Migration 004 is not required by this module.

Existing regression evidence: `vitest run tests/backend.test.ts` also passed **32/32** locally after parent integration updates.
