import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { apiApp } from '../src/server/api';
import { EMPTY_PROFILE } from '../src/shared/types';
import { now, sha256, type Env } from '../src/server/security';
import { pruneExpired } from '../src/server/services/email';

class Statement {
  constructor(readonly db: DatabaseSync, readonly sql: string, readonly values: unknown[] = []) {}
  bind(...values: unknown[]) { return new Statement(this.db, this.sql, values); }
  async first<T>() { return (this.db.prepare(this.sql).get(...this.values as (string | number | null)[]) ?? null) as T | null; }
  async all<T>() { return { results: this.db.prepare(this.sql).all(...this.values as (string | number | null)[]) as T[], meta: { changes: 0 } }; }
  async run() { return this.execute(); }
  execute() {
    const result = this.db.prepare(this.sql).run(...this.values as (string | number | null)[]);
    return { results: [], meta: { changes: Number(result.changes) } };
  }
}
class TestD1 {
  readonly db = new DatabaseSync(':memory:');
  constructor() {
    for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort())
      this.db.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  prepare(sql: string) { return new Statement(this.db, sql); }
  async batch(statements: Statement[]) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = statements.map(statement => statement.execute()); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
let db: TestD1, env: Env;
const token = 'local-test-session-token-more-than-twenty-characters';
beforeEach(async () => {
  vi.unstubAllGlobals();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Network forbidden in local tests'); }));
  db = new TestD1();
  env = { DB: db as unknown as D1Database, SESSION_SECRET: 'local-only-test-secret-with-at-least-32-characters', PUBLIC_ORIGIN: 'https://idvip.app', COOKIE_MODE: 'production' };
  db.db.prepare('INSERT INTO users(id,email,name,role,public_id,verified_at,created_at) VALUES(?,?,?,?,?,?,?)')
    .run('staff', 'staff@example.test', 'Staff', 'moderator', 1, now(), now());
  db.db.prepare('INSERT INTO sessions VALUES(?,?,?,?,?,?)').run(await sha256(token), 'staff', 'csrf', now(), now() + 3600, now());
});
async function request(path: string) {
  return apiApp.request('https://idvip.app' + path, { headers: { Cookie: '__Host-vip_session=' + token } }, env);
}
function seed(count = 105) {
  for (let index = 0; index < count; index++) {
    const id = 'user-' + index, site = 'site-' + index;
    db.db.prepare('INSERT INTO users(id,email,name,role,public_id,verified_at,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(id, id + '@example.test', 'Person ' + index, 'user', index + 2, now(), 1700000000);
    db.db.prepare('INSERT INTO sites(id,owner_id,slug,language,draft_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?)')
      .run(site, id, 'profile-' + index, 'en', JSON.stringify({ ...EMPTY_PROFILE, country: 'Rarecountry' }), now(), now());
    db.db.prepare('INSERT INTO reviews(id,site_id,owner_id,revision,kind,data_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run('review-' + index, site, id, 0, 'publish', JSON.stringify({ ...EMPTY_PROFILE, bio: 'Immutable ' + index }), 1700000000);
  }
}

describe('bounded admin pagination and filters', () => {
  it('exposes users beyond 100 with nextPage and server-side profile search', async () => {
    seed();
    const first = await request('/admin/users').then(response => response.json()) as any;
    expect(first.users).toHaveLength(100);
    expect(first.nextPage).toBe(2);
    const second = await request('/admin/users?page=2').then(response => response.json()) as any;
    expect(second.users).toHaveLength(6);
    expect(second.nextPage).toBeNull();
    expect(second.users.some((user: any) => user.id === 'user-104')).toBe(true);
    const profileSearch = await request('/admin/users?q=Rarecountry&limit=10').then(response => response.json()) as any;
    expect(profileSearch.users).toHaveLength(10);
    expect(profileSearch.users[0]).not.toHaveProperty('password_hash');
    expect(profileSearch.nextPage).toBe(2);
  });
  it('paginates immutable reviews and applies status/date/search before the limit', async () => {
    seed();
    const first = await request('/admin/reviews').then(response => response.json()) as any;
    expect(first.reviews).toHaveLength(100);
    expect(first.nextPage).toBe(2);
    const second = await request('/admin/reviews?page=2').then(response => response.json()) as any;
    expect(second.reviews).toHaveLength(5);
    expect(second.nextPage).toBeNull();
    const matched = await request('/admin/reviews?q=review-104&date=2023-11-14&from=1700000000&to=1700000000')
      .then(response => response.json()) as any;
    expect(matched.reviews).toHaveLength(1);
    expect(matched.reviews[0].data.bio).toBe('Immutable 104');
    expect((await request('/admin/reviews?status=reject').then(response => response.json()) as any).reviews).toEqual([]);
  });
  it('rejects unbounded/invalid filters and treats SQL and wildcard text literally', async () => {
    seed(1);
    for (const query of ['limit=101', 'page=0', 'date=2026-02-30', 'from=bad', 'from=2&to=1', 'status=invalid'])
      expect((await request('/admin/reviews?' + query)).status).toBe(400);
    expect((await request('/admin/users?q=' + encodeURIComponent("%' OR 1=1 --")).then(response => response.json()) as any).users).toEqual([]);
  });
});

describe('expired email and invitation cleanup', () => {
  function outbox(id: string, state: string, expiry: number, lease: number | null) {
    db.db.prepare('INSERT INTO email_outbox(id,to_email,payload_cipher,state,created_at,updated_at,next_attempt_at,expires_at,lease_until) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id, 'recipient@example.test', 'encrypted-payload', state, now() - 200, now(), 0, expiry, lease);
  }
  it('reclaims expired sending/unknown payloads but never a leased entry, and writes audited evidence', async () => {
    outbox('expired-sending', 'sending', now() - 1, now() - 1);
    outbox('expired-unknown', 'unknown', now() - 1, null);
    outbox('leased', 'sending', now() - 1, now() + 60);
    outbox('live', 'unknown', now() + 60, null);
    await pruneExpired(env);
    expect(db.db.prepare('SELECT id FROM email_outbox ORDER BY id').all().map(row => row.id)).toEqual(['leased', 'live']);
    expect(db.db.prepare("SELECT count(*) n FROM audit_events WHERE action='email.expire'").get()?.n).toBe(2);
    expect(JSON.stringify(db.db.prepare('SELECT * FROM audit_events').all())).not.toContain('recipient@example.test');
    expect(fetch).not.toHaveBeenCalled();
  });
  it('bounds expired invitation cleanup and never updates or removes a live invitation', async () => {
    for (let index = 0; index < 55; index++)
      db.db.prepare('INSERT INTO invitations(id,email,role,mode,invited_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
        .run('invite-' + index, 'recipient@example.test', 'user', 'managed', 'staff', now() - 100, now() - 1);
    db.db.prepare('INSERT INTO invitations(id,email,role,mode,invited_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?)')
      .run('live', 'recipient@example.test', 'user', 'managed', 'staff', now(), now() + 100);
    await pruneExpired(env);
    expect(db.db.prepare('SELECT count(*) n FROM invitations').get()?.n).toBe(6);
    expect(db.db.prepare("SELECT id FROM invitations WHERE id='live'").get()?.id).toBe('live');
    expect(db.db.prepare("SELECT count(*) n FROM audit_events WHERE action='invitation.expire'").get()?.n).toBe(50);
    expect(fetch).not.toHaveBeenCalled();
  });
});

it('keeps the existing navigation guard and binds UI retries to existing IDs/routes', () => {
  const source = readFileSync(new URL('../src/client/pages/Account.tsx', import.meta.url), 'utf8');
  expect(source).toContain('registerNavigationGuard(flush)');
  expect(source).toContain("deliveryId(error, 'challengeId')");
  expect(source).toContain('json: { email, purpose: mode, challengeId, locale: u.lang }');
  expect(source).toContain('/admin/outbox/${encodeURIComponent(pendingInvitationId)}/retry');
  expect(source).toContain('loadMore');
  expect(source).not.toContain('"/admin/reviews?status=all"');
  expect(source).toContain('r.consentRequired === true');
  expect(source).toContain('...(consentRequired ? { acceptCustody, termsAccepted: terms, ageConfirmed: age } : {})');
});

it('requires explicit custody consent with OTP before issuing a managed-user session', async () => {
  db.db.prepare("UPDATE users SET role='principal' WHERE id='staff'").run();
  db.db.prepare('INSERT INTO users(id,email,name,role,public_id,verified_at,created_at) VALUES(?,?,?,?,?,?,?)')
    .run('managed-user', 'managed@example.test', 'Managed', 'user', 2, 0, now());
  db.db.prepare('INSERT INTO custody(user_id,admin_id,created_at) VALUES(?,?,?)').run('managed-user', 'staff', now());
  const messages: { text: string }[] = [];
  env.EMAIL = { send: async message => { messages.push(message); return {messageId:'admin-native-'+messages.length}; } };
  async function post(path: string, json: unknown) {
    return apiApp.request('https://idvip.app' + path, {
      method: 'POST', headers: { Origin: 'https://idvip.app', 'Content-Type': 'application/json' },
      body: JSON.stringify(json),
    }, env);
  }
  const challenge = await post('/auth/request', { email: 'managed@example.test', purpose: 'login' }).then(response => response.json()) as any;
  expect(challenge.consentRequired).toBe(true);
  const pin = messages[0].text.match(/\b\d{6}\b/)![0];
  const refused = await post('/auth/verify', { challengeId: challenge.challengeId, pin });
  expect(refused.status).toBe(400);
  expect((await refused.json() as any).consentRequired).toBe(true);
  expect(db.db.prepare("SELECT user_id FROM custody WHERE user_id='managed-user'").get()).toBeTruthy();
  const accepted = await post('/auth/verify', { challengeId: challenge.challengeId, pin, acceptCustody: true, termsAccepted: true, ageConfirmed: true });
  expect(accepted.status).toBe(200);
  expect(db.db.prepare("SELECT user_id FROM custody WHERE user_id='managed-user'").get()).toBeUndefined();
  expect(db.db.prepare("SELECT count(*) n FROM audit_events WHERE action='managed.receive'").get()?.n).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
});
