/** Release L step 10 (migration 027): live status — Online / Away / Offline from activity, Busy and On leave set by the person or their manager. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { q, one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { ping, setPresence, me } from '../src/server/presence';
import { listUsers } from '../src/server/team';

let admin: Actor, boss: Actor, sam: Actor, sara: Actor;
const status = async (a: Actor) => (await me(a))!.status;

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  boss = await mkUser(admin, 'Carl Commercial', 'commercials_manager');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { manager_id: boss.id });
  sara = await mkUser(admin, 'Sara Sales', 'sales', undefined, { manager_id: boss.id });
});

test('never seen = offline; a ping with activity = online; 10 quiet minutes = away; 3 minutes without the app = offline', async () => {
  assert.equal(await status(sam), 'offline');
  await ping(sam, { active: true });
  assert.equal(await status(sam), 'online');
  await q(`update users set last_active_at = now() - interval '11 minutes' where id = $1`, [sam.id]);
  await ping(sam, { active: false });
  assert.equal(await status(sam), 'away');
  await q(`update users set last_seen_at = now() - interval '4 minutes' where id = $1`, [sam.id]);
  assert.equal(await status(sam), 'offline');
});

test('Busy and Available are set by the person', async () => {
  await ping(sam, { active: true });
  const r: any = await setPresence(sam, { presence: 'busy', note: 'In a meeting' });
  assert.equal(r.status, 'busy'); assert.equal(r.status_note, 'In a meeting');
  assert.equal((await setPresence(sam, { presence: 'available' }) as any).status, 'online');
  await assert.rejects(setPresence(sam, { presence: 'asleep' }), /Available, Busy or On leave/);
});

test('leave: the person or their manager; a colleague cannot; it ends after the return date', async () => {
  await assert.rejects(setPresence(sara, { user_id: sam.id, presence: 'leave' }), (e: any) => e.code === 'FORBIDDEN');
  await assert.rejects(setPresence(boss, { user_id: sam.id, presence: 'busy' }), (e: any) => e.code === 'FORBIDDEN');
  const r: any = await setPresence(boss, { user_id: sam.id, presence: 'leave', leave_until: '2099-01-01', note: 'Annual leave' });
  assert.equal(r.status, 'leave');
  const l: any = await listUsers(boss);
  assert.equal(l.users.find((u: any) => u.id === sam.id).status, 'leave');
  await q(`update users set leave_until = current_date - 1 where id = $1`, [sam.id]);
  assert.notEqual(await status(sam), 'leave', 'back after the return date');
});
