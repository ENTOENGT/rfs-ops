/**
 * Migration 038 — suggestions from the customer's past jobs. Regular customers ship the same way each time and often write
 * short enquiries: for what is still missing, the same customer's past enquiries / jobs are looked at and the value they used
 * is suggested ("used on 3 of the last 4 jobs from China") — Accept, Edit or Ignore, each kept in history_choices and the
 * enquiry's history. Never shipment-specific details (weight, size, pieces, packages, dates, value): those are always asked.
 * When the past jobs disagree, nothing is suggested and the detail stays for "Ask customer by email".
 */
import { Actor } from './auth';
import { bad, notFound, q, tx } from './db';
import { event, getJobFile, loadFile, updateJobFile } from './jobfiles';

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const blank = (v: unknown) => v === null || v === undefined || String(v).trim() === '';
/** Shipment-specific: never carried from another job. */
const SPECIFIC = /ready|weight|dimension|\bdims?\b|size|pieces|packages?|quantity|qty|volume|\bcbm\b|date|value|amount|price|container\s*no|seal/i;

// the details a past job may suggest; `same` = which past jobs count (same origin for pickup, same destination for delivery…)
type Built = { key: string; label: string; same: 'origin' | 'destination' | 'trade'; also?: string[] };
const BUILT: Built[] = [
  { key: 'pickup_address', label: 'Pickup address', same: 'origin' },
  { key: 'port_of_loading', label: 'Port / airport of loading', same: 'origin', also: ['pol_code'] },
  { key: 'named_place', label: 'Handover place', same: 'origin' },
  { key: 'delivery_address', label: 'Delivery address', same: 'destination' },
  { key: 'port_of_discharge', label: 'Port / airport of discharge', same: 'destination', also: ['pod_code'] },
  { key: 'incoterm', label: 'Incoterm', same: 'trade' },
  { key: 'cargo_description', label: 'Commodity', same: 'trade' },
];

export type HistoryHint = { key: string; label: string; value: string; extra: Record<string, any>; count: number; total: number; refs: { id: string; ref: string }[]; built_in: boolean };

export async function historyFor(actor: Actor, fileId: string) {
  if (!isUuid(fileId)) throw notFound('Job File');
  await loadFile(actor, fileId);
  const f: any = await getJobFile(actor, fileId);
  if (!f.customer_id || f.status !== 'enquiry') return { hints: [], unsure: [] };
  const ignored = new Set((await q(`select field_key || '|' || coalesce(value, '') k from history_choices where job_file_id = $1 and action = 'ignored'`, [fileId])).map((r: any) => r.k));
  return hintsFor(f, f.enquiry_gaps ?? [], ignored, fileId);
}

/**
 * The same on the New enquiry form, before it is saved (the addresses an Incoterm needs must be there to save, so this is
 * where a rough enquiry gets them). Accepting fills the form; what was used is logged when the enquiry is saved.
 */
export async function historyPreview(actor: Actor, b: any) {
  if (!actor.isSuperAdmin && !actor.has('jobfiles.create')) return { hints: [], unsure: [] };
  if (!isUuid(b?.customer_id)) return { hints: [], unsure: [] };
  const { enquiryGaps } = await import('../lib/enquiryGaps');
  const checks = await q('select id, label, ask_text, field_type, divisions, modes from enquiry_checks where is_active');
  const { directionOfDivision } = await import('../lib/commercialRules');
  const f = { ...b, direction: b.direction || directionOfDivision(b.division) || null, enquiry_details: b.enquiry_details ?? {}, cargo_lines: b.cargo_lines ?? [] };
  return hintsFor(f, enquiryGaps(f, checks as any), new Set(), null);
}

/** After a new enquiry is saved: the suggestions from past jobs that were used on it (accepted / edited), for the history. */
export async function logUsedHints(c: any, actor: Actor, fileId: string, used: unknown) {
  for (const u of (Array.isArray(used) ? used : []).slice(0, 20)) {
    if (!u?.key || !['accepted', 'edited'].includes(u.action)) continue;
    await c.query(`insert into history_choices (job_file_id, field_key, value, action, from_jobs, user_id) values ($1, $2, $3, $4, $5, $6)`,
      [fileId, String(u.key).slice(0, 60), String(u.value ?? '').slice(0, 500), u.action, String(u.from ?? '').slice(0, 200), actor.id]);
    await event(c, actor, fileId, { kind: 'note', title: `${String(u.label ?? u.key).slice(0, 60)} filled in from past jobs (${u.action})`, new_value: `${String(u.value ?? '').slice(0, 200)} — as on ${String(u.from ?? '').slice(0, 200)}` });
  }
}

async function hintsFor(f: any, gapList: any[], ignored: Set<string>, fileId: string | null) {
  // the customer's other enquiries / jobs, newest first (same direction; cancelled ones and this one left out)
  const past = await q(`select id, coalesce(job_no, enquiry_ref) ref, mode, direction, incoterm, origin_country, destination_country, pol_code, pod_code,
      port_of_loading, port_of_discharge, pickup_address, delivery_address, named_place, cargo_description, enquiry_details, created_at
    from job_files where customer_id = $1 and id <> coalesce($2, gen_random_uuid()) and deleted_at is null and status <> 'cancelled' and direction is not distinct from $3
    order by created_at desc limit 30`, [f.customer_id, fileId, f.direction ?? null]);
  if (!past.length) return { hints: [] as HistoryHint[], unsure: [] as string[] };
  const gaps = new Set(gapList.map((g: any) => g.key));
  const sameOrigin = (p: any) => (f.pol_code && p.pol_code ? p.pol_code === f.pol_code : f.origin_country ? p.origin_country === f.origin_country : true);
  const sameDest = (p: any) => (f.pod_code && p.pod_code ? p.pod_code === f.pod_code : f.destination_country ? p.destination_country === f.destination_country : true);
  const pool = (same: Built['same']) => past.filter((p) => same === 'origin' ? sameOrigin(p) : same === 'destination' ? sameDest(p) : p.mode === f.mode).slice(0, 10);

  const hints: HistoryHint[] = [], unsure: string[] = [];
  const decide = (key: string, label: string, rows: any[], get: (p: any) => unknown, builtIn: boolean, also: string[] = []) => {
    const withVal = rows.filter((p) => !blank(get(p)));
    if (!withVal.length) return;
    const by = new Map<string, any[]>();
    for (const p of withVal) { const v = String(get(p)).trim(); const k = v.toLowerCase().replace(/\s+/g, ' '); by.set(k, [...(by.get(k) ?? []), p]); }
    const list = [...by.values()].sort((a, b) => b.length - a.length)[0];
    const value = String(get(list[0])).trim();
    // sure enough: the same in most of the past jobs (one past job is enough when it is the only one)
    if (list.length * 2 <= withVal.length || ignored.has(`${key}|${value}`)) { if (!ignored.has(`${key}|${value}`)) unsure.push(label); return; }
    const extra: Record<string, any> = {}; for (const a of also) extra[a] = list[0][a] ?? null;
    hints.push({ key, label, value, extra, count: list.length, total: withVal.length, refs: list.slice(0, 3).map((p) => ({ id: p.id, ref: p.ref })), built_in: builtIn });
  };
  // the built-in details that are missing (Incoterm and commodity also when only blank)
  for (const b of BUILT) if (blank(f[b.key]) && (gaps.has(b.key) || ['incoterm', 'cargo_description'].includes(b.key)))
    decide(b.key, b.label, pool(b.same), (p) => p[b.key], true, b.also);
  // checklist answers that are a habit, not shipment-specific (HS code, insurance, stackable, DG…)
  for (const g of gapList) {
    if (g.built_in || SPECIFIC.test(g.label)) continue;
    decide(g.key, g.label, pool('trade'), (p) => p.enquiry_details?.[g.key], false);
  }
  return { hints, unsure };
}

/** Accept (as it is) or Edit (a corrected value) a hint: saved on the enquiry in the person's name, with history. */
export async function useHint(actor: Actor, fileId: string, b: any) {
  const res = await historyFor(actor, fileId);
  const h = res.hints.find((x) => x.key === b?.key);
  if (!h) throw bad('This suggestion is no longer open');
  const edited = b?.value !== undefined && String(b.value).trim() !== h.value;
  const value = edited ? String(b.value).trim() : h.value;
  if (!value) throw bad('Enter the value');
  const f: any = await getJobFile(actor, fileId);
  const patch: any = h.built_in ? { [h.key]: value, ...(edited ? {} : h.extra) } : { enquiry_details: { ...(f.enquiry_details ?? {}), [h.key]: value } };
  await updateJobFile(actor, fileId, patch);
  const from = h.refs.map((r) => r.ref).join(', ');
  await tx(async (c) => {
    await c.query(`insert into history_choices (job_file_id, field_key, value, action, from_jobs, user_id) values ($1, $2, $3, $4, $5, $6)`,
      [fileId, h.key, value, edited ? 'edited' : 'accepted', from, actor.id]);
    await event(c, actor, fileId, { kind: 'note', title: `${h.label} filled in from past jobs (${edited ? 'edited' : 'accepted'})`, new_value: `${value} — as on ${from}` });
  });
  return historyFor(actor, fileId);
}

/** Ignore a hint: not suggested again on this enquiry (the detail stays missing). */
export async function ignoreHint(actor: Actor, fileId: string, b: any) {
  const res = await historyFor(actor, fileId);
  const h = res.hints.find((x) => x.key === b?.key);
  if (!h) throw bad('This suggestion is no longer open');
  await tx(async (c) => {
    await c.query(`insert into history_choices (job_file_id, field_key, value, action, from_jobs, user_id) values ($1, $2, $3, 'ignored', $4, $5)`,
      [fileId, h.key, h.value, h.refs.map((r) => r.ref).join(', '), actor.id]);
    await event(c, actor, fileId, { kind: 'note', title: `Suggestion from past jobs ignored: ${h.label}`, new_value: h.value });
  });
  return historyFor(actor, fileId);
}
