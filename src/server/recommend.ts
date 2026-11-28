/**
 * Migration 039 — AI batch 3: the best vendor rate for what the customer actually asked, and the mismatches to clear first.
 *
 * Not the cheapest — the most suitable: the AI compares every vendor's full quote (total in one currency, charge lines, what is
 * included / excluded, transit, free days, validity, routing, line, their remarks) against the enquiry (Incoterm and the services
 * our customer's side needs, pickup / delivery, cargo, DG, ready date, the customer's remarks). It says which one and why, the
 * hidden costs and risks of each, or that none fits. Totals in one currency are worked out here (Settings exchange rates), never
 * by the AI. Each mismatch (scope / clause / responsibility) is kept in scope_issues and is asked of the customer, asked of the
 * vendor, or solved internally — never silently accepted. Only people who see cost.
 */
import crypto from 'crypto';
import { Actor } from './auth';
import { ApiError, bad, forbidden, notFound, one, q, tx } from './db';
import { aiConfig, askWithTool } from './ai';
import { event, getJobFile, loadFile } from './jobfiles';
import { customerScope, SVC_LABEL } from '../lib/opsRules';
import { fxRate } from '../lib/currency';

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
const canUse = (a: Actor) => a.fin.buyingView && (a.isSuperAdmin || a.has('vendors.requests') || a.has('quotes.view'));

/** The rates received on the enquiry, each with its total in AED (Settings rates) and its charge lines. */
async function ratesOf(fileId: string) {
  const fx = Object.fromEntries((await q(`select key, value from settings where key like 'fx\\_%'`)).map((r: any) => [String(r.key).slice(3), r.value === null ? null : Number(r.value)]));
  const rows = await q(`select r.id, r.request_no, r.status, r.quoted_cost::float total, r.currency, r.transit_days, r.free_days, r.etd, r.routing, r.carrier,
      r.rate_valid_until, r.inclusions, r.exclusions, r.vendor_reference, r.quote_details, r.rate_version, r.route_id, r.updated_at, v.name vendor_name, vt.name team_name
    from vendor_requests r join vendors v on v.id = r.vendor_id left join vendor_teams vt on vt.id = r.team_id
    where r.job_file_id = $1 and r.service = 'rate' and r.quoted_cost is not null and r.status not in ('cancelled', 'requested') order by r.quoted_cost`, [fileId]);
  const ch = rows.length ? await q(`select c.request_id, c.section, c.description, c.basis, c.quantity::float quantity, c.amount::float amount, c.currency
    from vendor_rate_charges c join vendor_requests r on r.id = c.request_id and c.rate_version = r.rate_version where c.request_id = any($1) order by c.sort_order`, [rows.map((r) => r.id)]) : [];
  for (const r of rows) {
    r.charges = ch.filter((c) => c.request_id === r.id);
    const x = fxRate(r.currency, 'AED', fx);
    r.total_aed = x ? Math.round(r.total * x * 100) / 100 : null;
    r.expired = !!r.rate_valid_until && String(r.rate_valid_until).slice(0, 10) < today();
  }
  return rows;
}
const keyOf = (rows: any[]) => crypto.createHash('sha1').update(JSON.stringify(rows.map((r) => [r.id, r.rate_version, r.total, r.currency, r.status, String(r.updated_at)]))).digest('hex');

export async function recommendBox(actor: Actor, fileId: string) {
  if (!isUuid(fileId)) throw notFound('Job File');
  if (!canUse(actor)) return { allowed: false };
  await loadFile(actor, fileId);
  const rows = await ratesOf(fileId);
  const last = await one('select * from vendor_recommendations where job_file_id = $1 order by created_at desc limit 1', [fileId]);
  const issues = await q(`select i.*, r.request_no, v.name vendor_name, u.full_name decided_by_name from scope_issues i left join vendor_requests r on r.id = i.vendor_request_id
    left join vendors v on v.id = r.vendor_id left join users u on u.id = i.decided_by where i.job_file_id = $1 order by i.status = 'open' desc, i.created_at`, [fileId]);
  return { allowed: true, configured: aiConfig().ready, rates: rows.length, current: !!last && last.input_key === keyOf(rows), last: last ?? null, issues };
}

const TOOL = {
  name: 'recommend_vendor',
  description: 'Recommend the most suitable vendor rate for this enquiry, and list the mismatches to clear.',
  input_schema: {
    type: 'object',
    properties: {
      recommended: { type: 'string', description: 'The request no. (VR-…) of the recommended rate, or "none" when no vendor meets the requirements.' },
      reason: { type: 'string', description: 'Two or three plain sentences: why this one, compared with the others (e.g. "Vendor A: competitive total, all requested services included, shorter transit. Vendor B is cheaper but excludes destination delivery.").' },
      no_fit_reason: { type: 'string', description: 'When none fits: what is missing in all of them.' },
      vendors: { type: 'array', items: { type: 'object', properties: {
        request_no: { type: 'string' }, verdict: { type: 'string', enum: ['recommended', 'suitable', 'not_suitable'] },
        missing_services: { type: 'array', items: { type: 'string' }, description: 'Services the customer needs that this quote does not include.' },
        hidden_costs: { type: 'array', items: { type: 'string' }, description: 'Exclusions / "subject to" / extra charges likely to be added later.' },
        risks: { type: 'array', items: { type: 'string' }, description: 'Expired or short validity, long transit, few free days, transhipment, payment terms, limitations.' },
      }, required: ['request_no', 'verdict'] } },
      issues: { type: 'array', description: 'Mismatches to clear before quoting: a contradiction between clauses, a requested service not quoted, a service quoted that the customer did not ask, a conflict between the customer requirement and the vendor terms, unclear responsibility for clearance / pickup / delivery.',
        items: { type: 'object', properties: {
          issue: { type: 'string', description: 'One sentence: what does not match.' },
          ask: { type: 'string', description: 'The question to send, written to the one who must answer (polite, one or two sentences).' },
          target: { type: 'string', enum: ['customer', 'vendor', 'internal'], description: 'Who must answer: the customer, the vendor, or something we decide internally.' },
          request_no: { type: 'string', description: 'The vendor\'s request no. when it is about one vendor.' },
        }, required: ['issue', 'target'] } },
    },
    required: ['recommended', 'reason', 'vendors'],
  },
};

/** Compare the rates now (the AI), keep the result and its mismatches. */
export async function runRecommend(actor: Actor, fileId: string) {
  if (!isUuid(fileId)) throw notFound('Job File');
  if (!canUse(actor)) throw forbidden('Only people who see cost can compare vendor rates');
  await loadFile(actor, fileId);
  const rows = await ratesOf(fileId);
  if (!rows.length) throw bad('No vendor rate has been received yet');
  const key = keyOf(rows);
  const last = await one('select * from vendor_recommendations where job_file_id = $1 order by created_at desc limit 1', [fileId]);
  if (last && last.input_key === key) return recommendBox(actor, fileId);        // nothing changed since the last comparison
  const f: any = await getJobFile(actor, fileId);
  const scope = customerScope(f.incoterm, f.direction);
  const details = (f.enquiry_checks ?? []).filter((c: any) => f.enquiry_details?.[c.id]).map((c: any) => `${c.label}: ${f.enquiry_details[c.id]}`).join('; ');
  const need = [
    `Shipment: ${f.direction} ${f.mode}, Incoterm ${f.incoterm ?? 'not given'}, ${f.port_of_loading ?? f.origin ?? '?'} → ${f.port_of_discharge ?? f.destination ?? '?'}`,
    scope ? `Under ${f.incoterm} our customer's side covers: ${[...scope].map((s) => SVC_LABEL[s]).join(', ') || 'nothing (the other party pays all)'}.` : '',
    `Our UAE services ticked: customs clearance ${f.needs_clearance ? 'yes' : 'no'}, transport (pickup / delivery) ${f.needs_transport ? 'yes' : 'no'}.`,
    // 27 Nov: vendors quote up to the port; the UAE side is ours, priced from our own local charges rate cards
    ['import', 'export'].includes(f.direction) ? `IMPORTANT: Reliance Freight Systems does the UAE side itself (customs clearance, ${f.direction === 'import' ? 'delivery' : 'pickup'} and UAE port / local charges), priced from our own rate cards. Vendors quote only up to the port. A vendor NOT quoting UAE clearance, ${f.direction === 'import' ? 'delivery' : 'pickup'} or UAE local charges is normal: never list it as missing, a mismatch or an issue.` : '',
    f.pickup_address ? `Pickup: ${f.pickup_address}` : '', f.delivery_address ? `Delivery: ${f.delivery_address}` : '',
    `Cargo: ${f.cargo_description ?? '?'}${f.gross_weight_kg ? `, ${f.gross_weight_kg} kg` : ''}${f.volume_cbm ? `, ${f.volume_cbm} CBM` : ''}`,
    details ? `Details: ${details}` : '', f.remarks ? `Customer remarks: ${f.remarks}` : '',
  ].filter(Boolean).join('\n');
  const quotes = rows.map((r) => [
    `${r.request_no} — ${r.vendor_name}${r.team_name ? ` (${r.team_name})` : ''}: ${r.currency} ${r.total}${r.total_aed !== null && r.currency !== 'AED' ? ` (≈ AED ${r.total_aed})` : ''}`,
    r.charges.length ? `  Charges: ${r.charges.map((c: any) => `${c.description} [${c.section}] ${c.currency} ${c.amount} × ${c.quantity} ${c.basis ?? ''}`).join('; ')}` : '  Charges: not broken down',
    `  Transit ${r.transit_days ?? '?'} days, free days ${r.free_days ?? '?'}, ETD ${r.etd ?? '?'}, routing ${r.routing ?? '?'}, line ${r.carrier ?? '?'}, valid until ${r.rate_valid_until ?? 'not given'}${r.expired ? ' (EXPIRED)' : ''}`,
    r.inclusions ? `  Includes: ${r.inclusions}` : '', r.exclusions ? `  Excludes: ${r.exclusions}` : '', r.quote_details ? `  Their remarks: ${String(r.quote_details).slice(0, 600)}` : '',
  ].filter(Boolean).join('\n')).join('\n\n');
  const { input: x, model } = await askWithTool(
    `You are an experienced freight forwarding operations executive at Reliance Freight Systems, Dubai. Compare the vendor rates for this enquiry and recommend the MOST SUITABLE one — not simply the cheapest — based on the complete quote and what the customer actually needs: total cost for the requested scope, services included vs needed, exclusions and likely extra costs, transit, free days, validity, routing, payment terms and limitations.
If no vendor covers what the customer needs, say "none" and why. Flag every mismatch (contradicting clauses, a needed service not quoted, a service quoted but not asked, unclear responsibility for clearance / pickup / delivery, customer requirement vs vendor terms) as an issue with who must answer. Never assume in a way that could create cost or liability for us. Today is ${today()}. Amounts "≈ AED" are already converted: use them to compare.`,
    `THE ENQUIRY\n${need}\n\nTHE VENDOR RATES\n${quotes}`, TOOL, 2000, 9500);

  const byNo = (no: unknown) => rows.find((r) => String(r.request_no).toUpperCase() === String(no ?? '').trim().toUpperCase());
  const rec = byNo(x?.recommended);
  const list = (v: unknown) => (Array.isArray(v) ? v : []).map((s: any) => String(s).slice(0, 300)).filter(Boolean).slice(0, 6);
  const result = {
    recommended_request_id: rec?.id ?? null, recommended_no: rec?.request_no ?? null, recommended_vendor: rec?.vendor_name ?? null,
    reason: String(x?.reason ?? '').slice(0, 1200), no_fit_reason: rec ? null : String(x?.no_fit_reason ?? x?.reason ?? '').slice(0, 800),
    vendors: rows.map((r) => {
      const v = (Array.isArray(x?.vendors) ? x.vendors : []).find((y: any) => byNo(y?.request_no)?.id === r.id) ?? {};
      return { request_id: r.id, request_no: r.request_no, vendor_name: r.vendor_name, team_name: r.team_name, total: r.total, currency: r.currency, total_aed: r.total_aed,
        transit_days: r.transit_days, free_days: r.free_days, rate_valid_until: r.rate_valid_until, expired: r.expired,
        verdict: r.id === rec?.id ? 'recommended' : ['suitable', 'not_suitable'].includes(v.verdict) ? v.verdict : 'suitable',
        missing_services: list(v.missing_services), hidden_costs: list(v.hidden_costs),
        risks: [...(r.expired ? ['The rate has expired — ask for a new validity'] : []), ...list(v.risks)].slice(0, 6) };
    }),
  };
  const saved = await tx(async (c) => {
    const s = await one(`insert into vendor_recommendations (job_file_id, input_key, result, model, created_by) values ($1, $2, $3, $4, $5) returning id`,
      [fileId, key, JSON.stringify(result), model, actor.id], c);
    // mismatches: the open ones from the last comparison make way for the new ones; the ones already acted on stay
    await c.query(`delete from scope_issues where job_file_id = $1 and status = 'open'`, [fileId]);
    for (const i of (Array.isArray(x?.issues) ? x.issues : []).slice(0, 10)) {
      if (!String(i?.issue ?? '').trim()) continue;
      const target = ['customer', 'vendor', 'internal'].includes(i.target) ? i.target : 'internal';
      const vr = byNo(i.request_no);
      await c.query(`insert into scope_issues (job_file_id, recommendation_id, vendor_request_id, issue, question, target) values ($1, $2, $3, $4, $5, $6)`,
        [fileId, s.id, target === 'vendor' ? vr?.id ?? null : vr?.id ?? null, String(i.issue).slice(0, 500), String(i.ask ?? '').slice(0, 800) || null, target === 'vendor' && !vr ? 'internal' : target]);
    }
    await event(c, actor, fileId, { kind: 'note', title: rec ? `AI recommends ${rec.request_no} (${rec.vendor_name})` : 'AI: no vendor rate fits the requirements',
      new_value: String(result.reason || result.no_fit_reason || '').slice(0, 300) });
    return s;
  });
  void saved;
  return recommendBox(actor, fileId);
}

/** A mismatch: marked as asked of the customer / the vendor (when the email goes) or solved internally (with a note). */
export async function issueAction(actor: Actor, id: string, b: any) {
  if (!isUuid(id)) throw notFound('Issue');
  if (!canUse(actor)) throw forbidden();
  const i = await one('select * from scope_issues where id = $1', [id]);
  if (!i) throw notFound('Issue');
  await loadFile(actor, i.job_file_id);
  const status = { asked_customer: 'asked_customer', asked_vendor: 'asked_vendor', resolved: 'resolved', reopen: 'open' }[String(b?.action)] as string | undefined;
  if (!status) throw bad('Unknown action');
  const note = String(b?.note ?? '').trim().slice(0, 500);
  if (status === 'resolved' && !note) throw bad('Say how it was solved');
  if (status === 'asked_vendor' && !i.vendor_request_id) throw new ApiError(400, 'NO_VENDOR', 'This mismatch is not about one vendor');
  await tx(async (c) => {
    await c.query(`update scope_issues set status = $2, note = $3, decided_by = $4, decided_at = now() where id = $1`, [id, status, note || i.note, actor.id]);
    await event(c, actor, i.job_file_id, { kind: 'note',
      title: status === 'resolved' ? 'Mismatch solved internally' : status === 'asked_customer' ? 'Mismatch: asked the customer' : status === 'asked_vendor' ? 'Mismatch: asked the vendor' : 'Mismatch opened again',
      new_value: `${i.issue}${note ? ` — ${note}` : ''}`.slice(0, 500) });
  });
  return recommendBox(actor, i.job_file_id);
}
