/** Invitation email for office staff: a one-time link (48 hours) to choose their own password — sent from the sender's
 *  Outlook when connected, otherwise returned ready to copy. No password is ever put in the email. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor, login } from '../src/server/auth';
import { createUser } from '../src/server/team';
import { appLinkInfo, inviteUser, useAppLink } from '../src/server/applink';
import * as ol from '../src/server/outlook';

let admin: Actor, opsMgr: Actor, newId: string, tempPw: string;
const sent: any[] = [];
const fake = (async (url: any, init: any = {}) => {
  if (String(url).endsWith('/v1.0/me/sendMail')) { sent.push(JSON.parse(String(init.body))); return new Response(null, { status: 202 }); }
  return new Response('{}', { status: 404 });
}) as typeof fetch;
const tokenOf = (body: string) => body.match(/\/join\/([A-Za-z0-9_-]+)/)![1];

before(async () => {
  await resetDb();
  Object.assign(process.env, { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', APP_URL: 'https://rfsops.netlify.app' });
  ol.setNetwork(fake);
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  opsMgr = await mkUser(admin, 'Ops Boss', 'operations_manager', 'operations');
  const role = (await one(`select id from roles where code = 'customer_service'`)).id;
  const dept = (await one(`select id from departments where code = 'customer_service'`)).id;
  const u = await createUser(admin, { full_name: 'Nina New', email: 'nina@rfs.ae', role_id: role, department_id: dept });
  newId = u.id; tempPw = u.temporary_password;
});

test('Outlook not connected: the email comes back ready to send, with a 48-hour link and no password', async () => {
  const r: any = await inviteUser(admin, newId);
  assert.equal(r.sent, false); assert.equal(r.to, 'nina@rfs.ae'); assert.equal(r.hours, 48);
  assert.equal(r.subject, 'You have been added to RFS CRM');
  assert.match(r.body, /^Hello Nina,/);
  assert.match(r.body, /https:\/\/rfsops\.netlify\.app\/join\/[A-Za-z0-9_-]{20,}/);
  assert.ok(!r.body.includes(tempPw), 'the password is never in the email');
  const l = await one(`select expires_at - created_at d from app_links where user_id = $1 and used_at is null order by created_at desc limit 1`, [newId]);
  assert.equal(l.d.hours ?? l.d.days * 24, 48);
  assert.deepEqual(await appLinkInfo(tokenOf(r.body)), { full_name: 'Nina New', sign_in_with: 'nina@rfs.ae', app_only: false });
  assert.equal(sent.length, 0);
});

test('Outlook connected: sent from the sender\'s own mailbox; the older link stops working', async () => {
  const old: any = await inviteUser(admin, newId);
  await ol.setPilot(admin, admin.id, true);
  await q(`insert into outlook_connections (user_id, ms_user_id, ms_email, refresh_token_enc, access_token_enc, access_expires_at, scope)
    values ($1, 'ms-a', 'admin@rfs.ae', $2, $3, now() + interval '1 hour', $4)`, [admin.id, ol.seal('r'), ol.seal('a'), ol.SCOPES]);
  const r: any = await inviteUser(admin, newId);
  assert.deepEqual([r.sent, r.to], [true, 'nina@rfs.ae']);
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].message.toRecipients, [{ emailAddress: { address: 'nina@rfs.ae' } }]);
  await assert.rejects(appLinkInfo(tokenOf(old.body)), (e: any) => e.code === 'LINK_EXPIRED');
  // the person opens the link, chooses a password and is signed in; the link can't be used twice
  const token = tokenOf(sent[0].message.body.content);
  await useAppLink(token, 'Welcome2026rfs');
  await assert.rejects(useAppLink(token, 'Another2026rfs'), (e: any) => e.code === 'LINK_EXPIRED');
  assert.equal((await one('select must_change_password from users where id = $1', [newId])).must_change_password, false);
  assert.ok(await login('nina@rfs.ae', 'Welcome2026rfs'));
  assert.ok(await one(`select 1 from audit_log where entity_id = $1 and action = 'Invitation emailed'`, [newId]));
});

test('after 48 hours the link no longer works', async () => {
  const r: any = await (async () => { await ol.setPilot(admin, admin.id, false); return inviteUser(admin, newId); })();
  await q(`update app_links set expires_at = now() - interval '1 minute' where user_id = $1 and used_at is null`, [newId]);
  await assert.rejects(appLinkInfo(tokenOf(r.body)), (e: any) => e.code === 'LINK_EXPIRED');
});

test('only someone who manages the person can invite; phone-app people get the app link instead', async () => {
  await assert.rejects(inviteUser(opsMgr, newId), (e: any) => ['NOT_FOUND', 'FORBIDDEN'].includes(e.code));
  const app = await mkUser(admin, 'Mo Messenger', 'messenger', 'messengers', { mobile: '0501112233' });
  await assert.rejects(inviteUser(admin, app.id), /app link/);
});
