/** Migration 012 — safety foundations: test-database guard, migration record, sign-in limit per address. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'fs';
import { resetDb, assertTestDatabase } from './helpers';
import { q, one } from '../src/server/db';
import { RATE_LIMIT, withRateLimit, clientAddress } from '../src/server/ratelimit';
import { login } from '../src/server/auth';
import { POST as loginRoute } from '../src/app/api/auth/login/route';

before(async () => { await resetDb(); });

const fromAddress = (ip: string, body: unknown) => new Request('http://x/api/auth/login', {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip }, body: JSON.stringify(body) });

test('Tests refuse to wipe a database whose name does not say "test"', () => {
  const before = process.env.ALLOW_DB_RESET;
  delete process.env.ALLOW_DB_RESET;
  try {
    assert.throws(() => assertTestDatabase('postgresql://u:p@aws-0-ap-south-1.pooler.supabase.com:6543/postgres'), /Refusing to run tests/);
    assert.doesNotThrow(() => assertTestDatabase('postgresql://u:p@localhost:5432/tms_test'));
    process.env.ALLOW_DB_RESET = 'yes';
    assert.doesNotThrow(() => assertTestDatabase('postgresql://u:p@host/postgres'));
  } finally {
    if (before === undefined) delete process.env.ALLOW_DB_RESET; else process.env.ALLOW_DB_RESET = before;
  }
});

test('Every migration file is recorded as run, and running 012 twice is harmless', async () => {
  const files = readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort();
  const rows = (await q<{ name: string }>('select name from schema_migrations order by name')).map((r) => r.name);
  for (const f of files.filter((f) => f <= '012')) assert.ok(rows.includes(f), `${f} recorded`);
  const { readFileSync } = await import('fs');
  await q(readFileSync('db/migrations/012_safety.sql', 'utf8'));
  assert.equal((await q('select name from schema_migrations')).length, rows.length);
});

test('The address is read from Netlify first, then the usual proxy headers', () => {
  const r = (h: Record<string, string>) => new Request('http://x', { headers: h });
  assert.equal(clientAddress(r({ 'x-nf-client-connection-ip': '5.5.5.5', 'x-forwarded-for': '6.6.6.6' })), '5.5.5.5');
  assert.equal(clientAddress(r({ 'x-forwarded-for': '7.7.7.7, 10.0.0.1' })), '7.7.7.7');
});

test(`After ${RATE_LIMIT.max} wrong passwords from one address it is refused for ${RATE_LIMIT.minutes} minutes; other addresses still work`, async () => {
  const wrong = { email: 'nobody@x.ae', password: 'wrong-password-1' };
  for (let i = 0; i < RATE_LIMIT.max; i++) {
    const res = await loginRoute(fromAddress('203.0.113.9', wrong), { params: {} });
    assert.equal(res.status, 401);
  }
  const blocked = await loginRoute(fromAddress('203.0.113.9', wrong), { params: {} });
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).error.code, 'TOO_MANY_ATTEMPTS');
  // even the right password is refused from that address while it is blocked
  const right = await loginRoute(fromAddress('203.0.113.9', { email: 'admin@company.local', password: 'ChangeMe!2026' }), { params: {} });
  assert.equal(right.status, 429);
  // another address signs in normally
  const other = await loginRoute(fromAddress('198.51.100.4', { email: 'admin@company.local', password: 'ChangeMe!2026' }), { params: {} });
  assert.equal(other.status, 200);
  // only a hash is stored, never the address
  const stored = await q<{ source_key: string }>('select distinct source_key from login_attempts');
  assert.ok(stored.every((s) => s.source_key.startsWith('ip:') && !s.source_key.includes('203.0.113.9')));
});

test('Only wrong passwords count — a disabled account or a good sign-in does not', async () => {
  await q('delete from login_attempts');
  const req = fromAddress('192.0.2.1', {});
  await assert.rejects(withRateLimit(req, 'login', (e) => e?.code === 'INVALID_LOGIN', async () => { throw Object.assign(new Error('x'), { code: 'DISABLED' }); }));
  await withRateLimit(req, 'login', () => true, () => login('admin@company.local', 'ChangeMe!2026'));
  assert.equal(Number((await one('select count(*) n from login_attempts')).n), 0);
  // the single-account lock from before still works on its own
  await q(`update users set failed_logins = 0, locked_until = null where email = 'admin@company.local'`);
});

test('Old failures are forgotten after the 15-minute window', async () => {
  await q('delete from login_attempts');
  const req = fromAddress('192.0.2.50', {});
  for (let i = 0; i < RATE_LIMIT.max; i++)
    await q(`insert into login_attempts (source_key, kind, attempted_at) values ($1, 'login', now() - interval '16 minutes')`,
      ['ip:' + (await import('crypto')).createHash('sha256').update('192.0.2.50').digest('hex')]);
  const out = await withRateLimit(req, 'login', () => true, async () => 'ok');
  assert.equal(out, 'ok');
});
