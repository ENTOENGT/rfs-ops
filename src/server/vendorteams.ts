/**
 * Migration 038 — vendor teams. One vendor can have several departments (Sea FCL team, Sea LCL team, Air import team, Cross
 * trade team…), each with its own email. A rate request picks the team that fits its mode and direction (or the one chosen
 * by hand); the email to the vendor goes to that team, and its replies are recognised as the vendor's.
 */
import { Actor } from './auth';
import { Db, audit, bad, forbidden, notFound, one, q, tx } from './db';
import { canManageCoverage } from './agents';

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const EMAIL = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/;
export const TEAM_MODES: [string, string][] = [['sea_fcl', 'Sea FCL'], ['sea_lcl', 'Sea LCL'], ['air', 'Air'], ['road', 'Road'], ['courier', 'Courier']];
export const TEAM_DIRECTIONS: [string, string][] = [['import', 'Import'], ['export', 'Export'], ['cross_trade', 'Cross trade']];
const canSee = (a: Actor) => canManageCoverage(a) || a.has('vendors.requests');
const txt = (v: unknown, max: number) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };

export async function listTeams(actor: Actor, vendorId: string) {
  if (!canSee(actor)) throw forbidden();
  if (!isUuid(vendorId)) throw notFound('Vendor');
  const v = await one('select id, name, email from vendors where id = $1 and deleted_at is null', [vendorId]);
  if (!v) throw notFound('Vendor');
  const rows = await q(`select t.*, (select count(*)::int from vendor_requests r where r.team_id = t.id) used from vendor_teams t
    where t.vendor_id = $1 order by t.is_active desc, t.name`, [vendorId]);
  return { vendor: v, rows, can_manage: canManageCoverage(actor) };
}

export async function saveTeam(actor: Actor, vendorId: string, b: any) {
  if (!canManageCoverage(actor)) throw forbidden('Only the Super Admin, the Commercials Manager or whoever manages vendors changes vendor teams');
  if (!isUuid(vendorId) || !(await one('select 1 from vendors where id = $1 and deleted_at is null', [vendorId]))) throw notFound('Vendor');
  await tx(async (c) => {
    if (b?.id !== undefined) {
      if (!isUuid(b.id) || !(await one('select 1 from vendor_teams where id = $1 and vendor_id = $2', [b.id, vendorId], c))) throw notFound('Team');
      if (b.active !== undefined) {                       // switched off / on — never deleted (old requests keep it)
        await c.query('update vendor_teams set is_active = $2, updated_at = now() where id = $1', [b.id, !!b.active]);
        await audit(c, actor, { entity_type: 'vendors', entity_id: vendorId, action: b.active ? 'Vendor team switched on' : 'Vendor team switched off', new_value: b.id });
        return;
      }
    }
    const name = txt(b?.name, 80);
    if (!name) throw bad('Enter the team name (e.g. Sea FCL team)');
    const email = txt(b?.email, 200)?.toLowerCase() ?? null;
    if (!email || !EMAIL.test(email)) throw bad('Enter the team\'s email');
    const cc = String(b?.cc_emails ?? '').split(/[,;\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
    const badCc = cc.find((x) => !EMAIL.test(x));
    if (badCc) throw bad(`Not an email address: ${badCc}`);
    const modes = (Array.isArray(b?.modes) ? b.modes : []).filter((m: string) => TEAM_MODES.some(([k]) => k === m));
    const dirs = (Array.isArray(b?.directions) ? b.directions : []).filter((m: string) => TEAM_DIRECTIONS.some(([k]) => k === m));
    const dup = await one('select 1 from vendor_teams where vendor_id = $1 and lower(name) = lower($2) and id <> coalesce($3, gen_random_uuid())', [vendorId, name, b?.id ?? null], c);
    if (dup) throw bad(`This vendor already has a team called "${name}"`);
    const vals = [name, modes, dirs, txt(b?.contact_person, 120), email, cc.join(', ') || null, txt(b?.phone, 40), txt(b?.note, 300)];
    if (b?.id) await c.query(`update vendor_teams set name = $2, modes = $3, directions = $4, contact_person = $5, email = $6, cc_emails = $7, phone = $8, note = $9, updated_at = now() where id = $1`, [b.id, ...vals]);
    else await c.query(`insert into vendor_teams (vendor_id, name, modes, directions, contact_person, email, cc_emails, phone, note, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [vendorId, ...vals, actor.id]);
    await audit(c, actor, { entity_type: 'vendors', entity_id: vendorId, action: b?.id ? 'Vendor team changed' : 'Vendor team added', new_value: `${name} <${email}>` });
  });
  return listTeams(actor, vendorId);
}

/**
 * The team for a mode and direction: the one made for exactly that (mode and direction both named) first, then one that names
 * the mode, then one that names the direction. A team that names another mode / direction never fits. None → the vendor's
 * own email.
 */
export async function pickTeam(db: Db, vendorId: string, mode: string | null | undefined, direction: string | null | undefined) {
  const teams = await q('select id, name, modes, directions from vendor_teams where vendor_id = $1 and is_active', [vendorId], db);
  let best: any = null, bestScore = 0;
  for (const t of teams) {
    const m = t.modes.length ? (mode && t.modes.includes(mode) ? 2 : -1) : 0;
    const d = t.directions.length ? (direction && t.directions.includes(direction) ? 1 : -1) : 0;
    if (m < 0 || d < 0) continue;
    const score = m + d;
    if (score > bestScore) { best = t; bestScore = score; }
  }
  return best as { id: string; name: string } | null;
}

/** For the "ask for a rate" form: the vendor's teams and the one that fits this enquiry. */
export async function teamsFor(actor: Actor, vendorId: string, fileId?: string | null) {
  if (!canSee(actor)) throw forbidden();
  if (!isUuid(vendorId)) throw notFound('Vendor');
  const f = isUuid(fileId) ? await one('select mode, direction from job_files where id = $1', [fileId]) : null;
  const rows = await q('select id, name, email, contact_person, modes, directions from vendor_teams where vendor_id = $1 and is_active order by name', [vendorId]);
  const pick = f ? await pickTeam(null as any, vendorId, f.mode, f.direction) : null;
  return { rows, suggested: pick?.id ?? null };
}

/** Check a team chosen by hand belongs to the vendor and is on. */
export async function checkTeam(db: Db, vendorId: string, teamId: unknown) {
  if (teamId === null || teamId === '' || teamId === undefined) return null;
  if (!isUuid(teamId) || !(await one('select 1 from vendor_teams where id = $1 and vendor_id = $2 and is_active', [teamId, vendorId], db))) throw bad('Choose one of this vendor\'s teams');
  return teamId;
}

/** Change the team on a request (the next email goes to the new team). '' / null = the vendor's own email. */
export async function setRequestTeam(actor: Actor, requestId: string, teamId: unknown) {
  if (!actor.isSuperAdmin && !actor.has('vendors.requests')) throw forbidden();
  const { getVendorRequest } = await import('./vendorreqs');
  const r: any = await getVendorRequest(actor, requestId);                  // may this person see it?
  if (!r.can?.update) throw forbidden('You can\'t change this request');
  await tx(async (c) => {
    const id = await checkTeam(c, r.vendor_id, teamId);
    if ((r.team_id ?? null) === id) return;
    await c.query('update vendor_requests set team_id = $2 where id = $1', [requestId, id]);
    const name = id ? (await one('select name from vendor_teams where id = $1', [id], c)).name : 'the vendor\'s own email';
    await c.query(`insert into vendor_request_events (request_id, title, details, user_id, user_name) values ($1, 'Team changed', $2, $3, $4)`,
      [requestId, `Now to ${name}${r.team_name ? ` (was ${r.team_name})` : ''}`, actor.id, actor.full_name]);
  });
  return getVendorRequest(actor, requestId);
}
