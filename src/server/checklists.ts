/**
 * Release M (migration 028) — the checklists the AI agent follows, kept by the Super Admin and Commercials Managers.
 * Step 1: the enquiry checklist (your own questions on top of the built-in enquiry rules).
 */
import { Actor } from './auth';
import { ApiError, Db, audit, forbidden, notFound, one, q, tx } from './db';
import { checksFor, EnquiryCheck } from '../lib/enquiryGaps';
import { QuoteCheck, QUOTE_FIELDS, quoteChecksFor } from '../lib/quoteGaps';
import { DIVISIONS } from '../lib/commercialRules';
import { MODES } from '../lib/jobfileRules';

const bad = (m: string) => new ApiError(400, 'VALIDATION', m);
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const canManageChecklists = (a: Actor) => a.isSuperAdmin || a.has('settings.manage') || a.has('commercial.manage');
const TYPES = ['text', 'yes_no', 'date', 'number'];

export async function allEnquiryChecks(db?: Db): Promise<EnquiryCheck[]> {
  return q('select id, label, ask_text, field_type, divisions, modes, is_active, sort from enquiry_checks order by sort, label', [], db) as any;
}

export async function listEnquiryChecks(actor: Actor, db?: Db) {
  const rows = await allEnquiryChecks(db);
  return { rows: canManageChecklists(actor) ? rows : rows.filter((r) => r.is_active), can_manage: canManageChecklists(actor),
    divisions: DIVISIONS, modes: MODES };
}

export async function saveEnquiryCheck(actor: Actor, b: any) {
  if (!canManageChecklists(actor)) throw forbidden();
  const label = String(b.label ?? '').trim(), ask = String(b.ask_text ?? '').trim();
  if (!label || label.length > 60) throw bad('Name the item (up to 60 characters)');
  if (!ask || ask.length > 300) throw bad('Write how to ask the customer (up to 300 characters)');
  const type = TYPES.includes(b.field_type) ? b.field_type : 'text';
  const divs = (Array.isArray(b.divisions) ? b.divisions : []).filter((d: string) => DIVISIONS.some(([k]: any) => k === d));
  const modes = (Array.isArray(b.modes) ? b.modes : []).filter((m: string) => MODES.some(([k]: any) => k === m));
  const sort = Number.isInteger(Number(b.sort)) ? Math.min(Math.max(Number(b.sort), 1), 999) : 100;
  return tx(async (c) => {
    const dup = await one('select id from enquiry_checks where lower(label) = lower($1)', [label], c);
    if (b.id) {
      if (!isUuid(b.id)) throw notFound('Item');
      const cur = await one('select * from enquiry_checks where id = $1', [b.id], c);
      if (!cur) throw notFound('Item');
      if (dup && dup.id !== cur.id) throw new ApiError(409, 'DUPLICATE', 'An item with this name already exists');
      const active = b.is_active === undefined ? cur.is_active : !!b.is_active;
      await c.query(`update enquiry_checks set label = $2, ask_text = $3, field_type = $4, divisions = $5, modes = $6, is_active = $7, sort = $8,
        updated_by = $9, updated_at = now() where id = $1`, [cur.id, label, ask, type, divs, modes, active, sort, actor.id]);
      await audit(c, actor, { entity_type: 'enquiry_check', entity_id: cur.id, action: 'Enquiry checklist item changed',
        old_value: `${cur.label}${cur.is_active ? '' : ' (off)'}`, new_value: `${label}${active ? '' : ' (off)'}`, sensitivity: 'general' });
    } else {
      if (dup) throw new ApiError(409, 'DUPLICATE', 'An item with this name already exists');
      const r = await one(`insert into enquiry_checks (label, ask_text, field_type, divisions, modes, sort, updated_by) values ($1,$2,$3,$4,$5,$6,$7) returning id`,
        [label, ask, type, divs, modes, sort, actor.id], c);
      await audit(c, actor, { entity_type: 'enquiry_check', entity_id: r.id, action: 'Enquiry checklist item added', new_value: label, sensitivity: 'general' });
    }
    return listEnquiryChecks(actor, c);
  });
}

/** Clean the answers typed on an enquiry: only items that apply to it, each in its own format. */
export async function cleanDetails(db: Db, raw: unknown, division: string | null, mode: string | null) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('Additional details are not in the right format');
  const checks = checksFor(await allEnquiryChecks(db), division, mode);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const c = checks.find((x) => x.id === k);
    if (!c) continue;                                            // an item that no longer applies is dropped
    const s = String(v ?? '').trim();
    if (!s) continue;
    if (s.length > 300) throw bad(`${c.label}: up to 300 characters`);
    if (c.field_type === 'yes_no' && !['yes', 'no'].includes(s)) throw bad(`${c.label}: choose Yes or No`);
    if (c.field_type === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(s)) throw bad(`${c.label}: choose a date`);
    if (c.field_type === 'number' && !Number.isFinite(Number(s))) throw bad(`${c.label}: type a number`);
    out[k] = s;
  }
  return out;
}

// ================================================================ Step 2: the agent quote checklist

export async function allQuoteChecks(db?: Db): Promise<QuoteCheck[]> {
  return q('select id, label, ask_text, field_key, modes, is_active, sort from quote_checks order by sort, label', [], db) as any;
}
export async function listQuoteChecks(actor: Actor, db?: Db) {
  const rows = await allQuoteChecks(db);
  return { rows: canManageChecklists(actor) ? rows : rows.filter((r) => r.is_active), can_manage: canManageChecklists(actor), modes: MODES, fields: QUOTE_FIELDS };
}
/** Add or change an item. An item that reads a field of the rate request keeps that field; new items are extra questions. */
export async function saveQuoteCheck(actor: Actor, b: any) {
  if (!canManageChecklists(actor)) throw forbidden();
  const label = String(b.label ?? '').trim(), ask = String(b.ask_text ?? '').trim();
  if (!label || label.length > 60) throw bad('Name the item (up to 60 characters)');
  if (!ask || ask.length > 300) throw bad('Write how to ask the agent (up to 300 characters)');
  const modes = (Array.isArray(b.modes) ? b.modes : []).filter((m: string) => MODES.some(([k]: any) => k === m));
  const sort = Number.isInteger(Number(b.sort)) ? Math.min(Math.max(Number(b.sort), 1), 999) : 100;
  return tx(async (c) => {
    const dup = await one('select id from quote_checks where lower(label) = lower($1)', [label], c);
    if (b.id) {
      if (!isUuid(b.id)) throw notFound('Item');
      const cur = await one('select * from quote_checks where id = $1', [b.id], c);
      if (!cur) throw notFound('Item');
      if (dup && dup.id !== cur.id) throw new ApiError(409, 'DUPLICATE', 'An item with this name already exists');
      const active = b.is_active === undefined ? cur.is_active : !!b.is_active;
      await c.query(`update quote_checks set label = $2, ask_text = $3, modes = $4, is_active = $5, sort = $6, updated_by = $7, updated_at = now() where id = $1`,
        [cur.id, label, ask, modes, active, sort, actor.id]);
      await audit(c, actor, { entity_type: 'quote_check', entity_id: cur.id, action: 'Agent quote checklist item changed',
        old_value: `${cur.label}${cur.is_active ? '' : ' (off)'}`, new_value: `${label}${active ? '' : ' (off)'}`, sensitivity: 'general' });
    } else {
      if (dup) throw new ApiError(409, 'DUPLICATE', 'An item with this name already exists');
      const r = await one('insert into quote_checks (label, ask_text, modes, sort, updated_by) values ($1,$2,$3,$4,$5) returning id', [label, ask, modes, sort, actor.id], c);
      await audit(c, actor, { entity_type: 'quote_check', entity_id: r.id, action: 'Agent quote checklist item added', new_value: label, sensitivity: 'general' });
    }
    return listQuoteChecks(actor, c);
  });
}
/** Clean the answers to the extra questions on a rate request (only questions that apply to its mode). */
export async function cleanQuoteDetails(db: Db, raw: unknown, mode: string | null) {
  if (raw === null || raw === undefined) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw bad('Quote details are not in the right format');
  const checks = quoteChecksFor(await allQuoteChecks(db), mode).filter((c) => !c.field_key);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const c = checks.find((x) => x.id === k);
    const s = String(v ?? '').trim();
    if (!c || !s) continue;
    if (s.length > 500) throw bad(`${c.label}: up to 500 characters`);
    out[k] = s;
  }
  return out;
}
