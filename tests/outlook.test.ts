/** G3 step 1 (migration 029): connecting a pilot user's Outlook — pilot switch, Microsoft sign-in with state + PKCE,
 *  tokens stored encrypted, refreshed when they run out, disconnect. Microsoft is replaced by a fake. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'crypto';
import { resetDb, mkUser } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import * as ol from '../src/server/outlook';

let admin: Actor, sam: Actor, sara: Actor;
const calls: { url: string; body: string }[] = [];
let tokenN = 0;
let challenge = '';
const fake = (async (url: any, init: any = {}) => {
  const u = String(url), body = String(init.body ?? '');
  calls.push({ url: u, body });
  const json = (j: any, status = 200) => new Response(JSON.stringify(j), { status, headers: { 'Content-Type': 'application/json' } });
  if (u.includes('/oauth2/v2.0/token')) {
    const p = new URLSearchParams(body);
    if (p.get('grant_type') === 'authorization_code') {
      // PKCE: the verifier must match the challenge sent at the start
      if (createHash('sha256').update(p.get('code_verifier')!).digest('base64url') !== challenge) return json({ error: 'invalid_grant', error_description: 'PKCE mismatch' }, 400);
      if (p.get('client_secret') !== 'test-client-secret') return json({ error: 'invalid_client' }, 401);
    }
    tokenN += 1;
    return json({ access_token: `access-${tokenN}`, refresh_token: `refresh-${tokenN}`, expires_in: 3600, scope: ol.SCOPES });
  }
  if (u.includes('/v1.0/me')) return json({ id: 'ms-sam', displayName: 'Sam Sales', mail: 'Sam@RFS.ae' });
  return json({ error: { message: 'unknown' } }, 404);
}) as typeof fetch;

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  const cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
  sara = await mkUser(admin, 'Sara Sales', 'sales', undefined, { coordinator_id: cora.id });
  ol.setNetwork(fake);
});

test('not set up yet: a clear message, nothing breaks', async () => {
  delete process.env.MS_CLIENT_SECRET;
  assert.equal((await ol.status(sam)).configured, false);
  await assert.rejects(ol.startConnect(sam), (e: any) => e.code === 'NOT_SET_UP');
  Object.assign(process.env, { MS_TENANT_ID: '95acc64b-7fde-4edc-b2db-063774e47e36', MS_CLIENT_ID: '3e1eca78-f72a-41a9-b05d-1d140ae5fb6f',
    MS_CLIENT_SECRET: 'test-client-secret', APP_URL: 'https://rfsops.netlify.app' });
});

test('only pilot users connect; only the Super Admin chooses them', async () => {
  await assert.rejects(ol.startConnect(sam), (e: any) => e.code === 'FORBIDDEN');
  await assert.rejects(ol.setPilot(sara, sam.id, true), (e: any) => e.code === 'FORBIDDEN');
  await ol.setPilot(admin, sam.id, true);
  assert.equal((await ol.status(sam)).pilot, true);
});

test('sign-in: the right Microsoft page; the code is swapped only with the matching cookie; tokens saved encrypted', async () => {
  const s = await ol.startConnect(sam);
  const url = new URL(s.url);
  assert.equal(url.origin + url.pathname, 'https://login.microsoftonline.com/95acc64b-7fde-4edc-b2db-063774e47e36/oauth2/v2.0/authorize');
  assert.equal(url.searchParams.get('client_id'), '3e1eca78-f72a-41a9-b05d-1d140ae5fb6f');
  assert.equal(url.searchParams.get('redirect_uri'), 'https://rfsops.netlify.app/api/outlook/callback');
  assert.match(url.searchParams.get('scope')!, /offline_access .*Mail\.ReadWrite Mail\.Send/);
  challenge = url.searchParams.get('code_challenge')!;
  const state = url.searchParams.get('state')!;
  await assert.rejects(ol.finishConnect(sam, { code: 'abc', state: 'wrong' }, s.cookie), /someone else/);
  await assert.rejects(ol.finishConnect(sara, { code: 'abc', state }, s.cookie), /someone else/);
  await assert.rejects(ol.finishConnect(sam, { code: 'abc', state }, undefined), /expired/);
  await assert.rejects(ol.finishConnect(sam, { error: 'access_denied' }, s.cookie), /cancelled/);
  const r = await ol.finishConnect(sam, { code: 'abc', state }, s.cookie);
  assert.equal(r.email, 'sam@rfs.ae');
  const row = await one('select * from outlook_connections where user_id = $1', [sam.id]);
  assert.ok(!row.refresh_token_enc.includes('refresh-'), 'refresh token is encrypted');
  assert.equal(ol.unseal(row.refresh_token_enc), 'refresh-1');
  const st: any = await ol.status(sam);
  assert.equal(st.connected, true); assert.equal(st.ms_email, 'sam@rfs.ae');
  assert.equal(JSON.stringify(st).includes('refresh'), false, 'no token ever goes to the screen');
});

test('the access token is refreshed when it runs out, and the new refresh token is kept', async () => {
  assert.equal(await ol.accessToken(sam.id), 'access-1');
  await q(`update outlook_connections set access_expires_at = now() - interval '1 minute' where user_id = $1`, [sam.id]);
  assert.equal(await ol.accessToken(sam.id), 'access-2');
  assert.equal(ol.unseal((await one('select refresh_token_enc from outlook_connections where user_id = $1', [sam.id])).refresh_token_enc), 'refresh-2');
});

test('disconnect; switching the pilot off also disconnects', async () => {
  await ol.disconnect(sam);
  assert.equal((await ol.status(sam)).connected, false);
  await q(`insert into outlook_connections (user_id, ms_user_id, ms_email, refresh_token_enc) values ($1, 'x', 'sam@rfs.ae', $2)`, [sam.id, ol.seal('r')]);
  await ol.setPilot(admin, sam.id, false);
  assert.equal((await ol.status(sam)).connected, false);
});
