/**
 * Templates (Part G1): default quotation terms and email templates, kept by the Commercials Manager.
 * The most specific active template wins: one customer's own > division + mode (+ FCL/LCL) > division > any.
 * Templates only fill new work: an issued quotation keeps its own copy of its texts (and every version keeps a snapshot).
 * Every save writes a full copy to the history table, which can't be changed or deleted.
 */
import { Actor } from './auth';
import { ApiError, bad, Db, forbidden, one, q, tx } from './db';
import { DIVISIONS } from '../lib/commercialRules';
import { EMAIL_TEMPLATES, TERM_FIELDS, TEMPLATE_MODES, SHIPMENT_TYPES, badPlaceholders, modeParts } from '../lib/templateRules';

const UUID = /^[0-9a-f-]{36}$/i;
const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
const txt = (v: unknown, max: number) => { const s = String(v ?? '').trim(); return s ? s.slice(0, max) : null; };
const canManage = (a: Actor) => a.isSuperAdmin || a.has('templates.manage');
const oneOf = (v: unknown, list: [string, string][], label: string) => {
  if (v === undefined || v === null || v === '') return null;
  if (!list.some(([k]) => k === v)) throw bad(`Choose the ${label}`);
  return String(v);
};
/** Score of a template against a shipment: -1 = does not apply; higher = more specific. */
const score = (t: any, k: { division: string | null; mode: string | null; type: string | null; customer_id: string | null }) => {
  for (const [col, val] of [['division', k.division], ['mode', k.mode], ['shipment_type', k.type], ['customer_id', k.customer_id]] as const)
    if (t[col] && t[col] !== val) return -1;
  return (t.customer_id ? 8 : 0) + (t.division ? 4 : 0) + (t.mode ? 2 : 0) + (t.shipment_type ? 1 : 0);
};
const best = <T,>(rows: T[], k: any) => rows.map((t) => ({ t, s: score(t, k) })).filter((x) => x.s >= 0)
  .sort((a, b) => b.s - a.s || String((b.t as any).updated_at).localeCompare(String((a.t as any).updated_at)))[0]?.t ?? null;

// ------------------------------------------------------------ quotation terms
export async function listTermTemplates(actor: Actor) {
  if (!canManage(actor) && !actor.has('quotes.create')) throw forbidden();
  const rows = await q(`select t.*, c.name customer_name, u.full_name updated_by_name from quote_term_templates t
    left join customers c on c.id = t.customer_id left join users u on u.id = t.updated_by order by t.is_active desc, t.name`);
  const hist = await q(`select h.template_id, h.action, h.user_name, h.at from quote_term_template_history h order by h.at desc limit 200`);
  return { rows, history: hist, can_manage: canManage(actor) };
}
export async function saveTermTemplate(actor: Actor, b: any) {
  if (!canManage(actor)) throw forbidden('Only the Commercials Manager can change templates');
  const v: Record<string, unknown> = {
    name: txt(b.name, 120), division: oneOf(b.division, DIVISIONS, 'division'), mode: oneOf(b.mode, TEMPLATE_MODES, 'mode'),
    shipment_type: oneOf(b.shipment_type, SHIPMENT_TYPES, 'FCL / LCL'), customer_id: b.customer_id ? (isUuid(b.customer_id) ? b.customer_id : (() => { throw bad('Choose the customer'); })()) : null,
    is_active: b.is_active !== false,
  };
  if (!v.name) throw bad('Give the template a name');
  if (v.shipment_type && v.mode !== 'sea') throw bad('FCL / LCL applies to sea only');
  for (const [k] of TERM_FIELDS) v[k] = txt(b[k], 4000);
  if (!TERM_FIELDS.some(([k]) => v[k])) throw bad('Write at least one of the texts');
  return tx(async (c) => {
    if (v.customer_id && !(await one('select 1 from customers where id = $1 and deleted_at is null', [v.customer_id], c))) throw bad('Customer not found');
    const cols = Object.keys(v);
    let id = b.id as string | undefined;
    if (id) {
      if (!isUuid(id) || !(await one('select 1 from quote_term_templates where id = $1 for update', [id], c))) throw new ApiError(404, 'NOT_FOUND', 'Template not found');
      await c.query(`update quote_term_templates set ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_by = $${cols.length + 2}, updated_at = now() where id = $1`,
        [id, ...cols.map((k) => v[k]), actor.id]);
    } else {
      id = (await one(`insert into quote_term_templates (${cols.join(', ')}, created_by, updated_by) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${cols.length + 1}, $${cols.length + 1}) returning id`,
        [...cols.map((k) => v[k]), actor.id], c)).id;
    }
    await c.query('insert into quote_term_template_history (template_id, action, snapshot, user_id, user_name) values ($1,$2,$3,$4,$5)',
      [id, b.id ? (v.is_active ? 'Changed' : 'Switched off') : 'Created', JSON.stringify(v), actor.id, actor.full_name]);
    return { id };
  });
}
/** The terms a new quotation starts with, for this customer and shipment. */
export async function pickTerms(k: { division: string | null; service_type?: string | null; customer_id: string | null }, db?: Db) {
  const { mode, type } = modeParts(k.service_type);
  const rows = await q('select * from quote_term_templates where is_active', [], db);
  const t = best(rows, { division: k.division, mode, type, customer_id: k.customer_id });
  return t ? { template_id: t.id, template_name: t.name, ...Object.fromEntries(TERM_FIELDS.map(([f]) => [f, t[f] ?? ''])) } : null;
}
export async function pickTermsFor(actor: Actor, p: Record<string, string>) {
  if (!actor.has('quotes.create')) throw forbidden();
  let division: string | null = actor.division ?? null;
  if (isUuid(p.job_file_id)) division = (await one('select division from job_files where id = $1', [p.job_file_id]))?.division ?? division;
  return (await pickTerms({ division, service_type: p.service_type || null, customer_id: isUuid(p.customer_id) ? p.customer_id : null })) ?? { template_id: null, template_name: null };
}

// ------------------------------------------------------------ email templates
export async function listEmailTemplates(actor: Actor) {
  if (!canManage(actor)) throw forbidden();
  const rows = await q(`select t.*, c.name customer_name, u.full_name updated_by_name from email_templates t
    left join customers c on c.id = t.customer_id left join users u on u.id = t.updated_by order by t.template_key, t.is_active desc, t.updated_at desc`);
  const hist = await q('select template_id, action, user_name, at from email_template_history order by at desc limit 200');
  return { rows, history: hist, built_in: EMAIL_TEMPLATES.map(([key, name, ctx, subject, body]) => ({ key, name, ctx, subject, body })) };
}
export async function saveEmailTemplate(actor: Actor, b: any) {
  if (!canManage(actor)) throw forbidden('Only the Commercials Manager can change templates');
  const def = EMAIL_TEMPLATES.find((t) => t[0] === b.template_key);
  if (!def) throw bad('Choose which email this template is for');
  const v: Record<string, unknown> = {
    template_key: def[0], division: oneOf(b.division, DIVISIONS, 'division'), mode: oneOf(b.mode, TEMPLATE_MODES, 'mode'),
    customer_id: b.customer_id ? (isUuid(b.customer_id) ? b.customer_id : (() => { throw bad('Choose the customer'); })()) : null,
    subject: txt(b.subject, 300), body: txt(b.body, 8000), is_active: b.is_active !== false,
  };
  if (!v.subject) throw bad('Write the subject');
  if (!v.body) throw bad('Write the email text');
  if (def[2] === 'vendor' && v.customer_id) throw bad('Emails to agents and carriers cannot be set per customer');
  // the Enquiry Ref must stay in every subject (decision: one subject from enquiry to closing)
  if (!/\{\{\s*(ThreadSubject|EnquiryReference)\s*\}\}/.test(String(v.subject)))
    throw new ApiError(400, 'VALIDATION', 'The subject must contain {{ThreadSubject}} (or at least {{EnquiryReference}}), so the email stays in the shipment\'s thread', { fields: { subject: 'Add {{ThreadSubject}}' } });
  const wrong = badPlaceholders(`${v.subject}\n${v.body}`, def[2]);
  if (wrong.length) throw new ApiError(400, 'VALIDATION', `These placeholders can't be used in this email: ${wrong.map((w) => `{{${w}}}`).join(', ')}${def[2] === 'vendor' ? ' (agents never get the customer\'s name or prices)' : ''}`,
    { fields: { body: 'Fix the placeholders' } });
  return tx(async (c) => {
    if (v.customer_id && !(await one('select 1 from customers where id = $1 and deleted_at is null', [v.customer_id], c))) throw bad('Customer not found');
    const cols = Object.keys(v);
    let id = b.id as string | undefined;
    if (id) {
      if (!isUuid(id) || !(await one('select 1 from email_templates where id = $1 for update', [id], c))) throw new ApiError(404, 'NOT_FOUND', 'Template not found');
      await c.query(`update email_templates set ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_by = $${cols.length + 2}, updated_at = now() where id = $1`,
        [id, ...cols.map((k) => v[k]), actor.id]);
    } else {
      id = (await one(`insert into email_templates (${cols.join(', ')}, created_by, updated_by) values (${cols.map((_, i) => `$${i + 1}`).join(', ')}, $${cols.length + 1}, $${cols.length + 1}) returning id`,
        [...cols.map((k) => v[k]), actor.id], c)).id;
    }
    await c.query('insert into email_template_history (template_id, action, snapshot, user_id, user_name) values ($1,$2,$3,$4,$5)',
      [id, b.id ? (v.is_active ? 'Changed' : 'Switched off') : 'Created', JSON.stringify(v), actor.id, actor.full_name]);
    return { id };
  });
}
/** The template to use for this email: the most specific saved one, else the built-in text. */
export async function pickEmailTemplate(key: string, k: { division: string | null; mode: string | null; customer_id: string | null }, db?: Db) {
  const def = EMAIL_TEMPLATES.find((t) => t[0] === key);
  if (!def) throw bad('Unknown email');
  const rows = await q('select * from email_templates where is_active and template_key = $1', [key], db);
  const t = best(rows, { division: k.division, mode: modeParts(k.mode).mode, type: null, customer_id: def[2] === 'vendor' ? null : k.customer_id });
  return t ? { key, name: def[1], ctx: def[2], subject: t.subject as string, body: t.body as string, source: 'saved' as const, template_id: t.id as string }
    : { key, name: def[1], ctx: def[2], subject: def[3], body: def[4], source: 'built-in' as const, template_id: null };
}
