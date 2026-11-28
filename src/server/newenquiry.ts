/**
 * Migration 035 — the AI finds new enquiries in the Salesman's / Coordinator's inbox and fills them in.
 *
 *  1. screenInbox: every inbox email that matched no shipment (known customer, or an unknown sender) gets one quick AI look
 *     at its sender, subject and first lines: a NEW ENQUIRY, a reply about something existing, or other. An unknown sender's
 *     email that is not an enquiry is not kept (its subject and text are wiped). The same email in two inboxes is looked at once.
 *  2. draftEnquiry: "Create enquiry" — the AI reads the whole email and fills a new enquiry: customer (an existing one by
 *     the sender's email / company domain, or a NEW customer from the signature), Salesman, mode, Incoterm, countries and
 *     ports (from the port list), addresses, cargo, weight, ready date, DG. Kept on the email, so it is read once.
 *  3. createFromEmail: the person checks the form and presses Save: the customer is created when new (with the sender as
 *     main contact, in To, and the Salesman as main owner), the enquiry is opened, and the email — in every inbox it came
 *     to — is filed on it. All in one go: nothing half-made.
 */
import { Actor } from './auth';
import { ApiError, audit, bad, forbidden, notFound, one, q, tx } from './db';
import { aiConfig, askWithTool } from './ai';
import { graph } from './outlook';
import { readAttachments } from './attachments';
import { createJobFile } from './jobfiles';
import { fileOnShipment } from './inbox';
import { ensurePortsLoaded } from './ports';
import { HOME_COUNTRY } from './agents';
import { parseField } from './masters';
import { MASTERS } from '../lib/masters';
import { decideServices, dgFromText, ownWords, READY_REMARK, saysReady } from '../lib/opsRules';
import { INCOTERMS } from '../lib/jobfileRules';
import { PACKAGE_TYPES, cargoTotals, lineProblem, packagesFrom } from '../lib/cargoRules';

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const PUBLIC = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'aol.com', 'msn.com', 'yandex.com', 'proton.me', 'protonmail.com']);
/** Raised when the reading gets better (attachments, cargo lines, HS codes…): drafts kept from before are read again once. */
const DRAFT_VERSION = 4;                    // 4 = batch 1 operations rules (services, ready, general cargo, remarks, flags)
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });

// ---------------------------------------------------------------- 1. the quick look
const CLASSIFY = {
  name: 'classify_email',
  description: 'Say what kind of email this is for a freight forwarder.',
  input_schema: { type: 'object', properties: {
    kind: { type: 'string', enum: ['new_enquiry', 'reply', 'other'],
      description: 'new_enquiry: someone asks us for a rate, a quotation, "the best rate", or to move / clear / deliver / store a new shipment — also when the details are only in an attached sheet or file ("please find attached, kindly quote"). reply: about a shipment, quote, booking or invoice already going on (mentions a reference, booking, BL, invoice). other: anything else (newsletters, adverts, greetings, rate sheets or offers that vendors send us, personal, system mails, spam).' },
    summary: { type: 'string', description: 'One short line of what they want, e.g. "2x40HC Hamburg to Jebel Ali, FOB, ready 25 Nov". Empty for other.' },
  }, required: ['kind', 'summary'] },
};

/** Look at up to `max` emails of this person not looked at yet. Safe to call often; stops at the first AI problem. */
/** 26 Nov: an automatic email (out of office, bounce, newsletter, no-reply) is sorted without asking the AI. */
export function plainlyOther(m: { from_addr?: string | null; subject?: string | null; body_excerpt?: string | null }) {
  const from = String(m.from_addr ?? '').toLowerCase(), subj = String(m.subject ?? '').toLowerCase();
  if (/^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|notifications?|newsletter|marketing|bounce)[@+.-]/.test(from)) return 'Automatic email';
  if (/^(automatic reply|auto(matic)?[- ]reply|out of (the )?office|undeliverable|delivery status notification|read:|accepted:|declined:|tentative:)/i.test(subj)) return 'Automatic reply';
  if (/unsubscribe|view (this|it) in your browser/i.test(String(m.body_excerpt ?? '')) && !/rate|quot|freight|shipment|container|cargo/i.test(subj)) return 'Newsletter';
  return null;
}

/** Run at most `n` at a time (the AI calls of one check go side by side instead of one after another). */
export async function inBatches<T, R>(items: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += n) out.push(...await Promise.all(items.slice(i, i + n).map(fn)));
  return out;
}

export async function screenInbox(actor: Actor, max = 6) {
  if (!aiConfig().ready) return { screened: 0, off: true };
  const rows = await q(`select * from outlook_inbox where user_id = $1 and ai_checked_at is null and status in ('screen', 'unmatched')
    order by received_at desc nulls last limit $2`, [actor.id, Math.min(12, Math.max(1, max))]);
  let failed: unknown = null;
  // 26 Nov: up to 4 looks at the same time; automatic emails and emails already looked at in another inbox need no AI
  const looks = await inBatches(rows, 4, async (m: any) => {
    const same = m.internet_message_id ? await one(`select ai_kind kind, ai_summary summary from outlook_inbox
      where internet_message_id = $1 and id <> $2 and ai_checked_at is not null and ai_kind is not null limit 1`, [m.internet_message_id, m.id]) : null;
    if (same) return { m, res: same };
    const rule = plainlyOther(m);
    if (rule) return { m, res: { kind: 'other', summary: rule } };
    try {
      const { input } = await askWithTool(
        'You sort the inbox of a salesman at Reliance Freight Systems, a freight forwarder in Dubai. Decide what kind of email this is. Judge only from what is shown.',
        `From: ${m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr}${m.known_as ? ` (${m.known_as})` : ' (not a known customer yet)'}\nSubject: ${m.subject ?? ''}${m.has_attachments ? '\nHas attachments: yes' : ''}\n\n${String(m.body_excerpt ?? '').slice(0, 1000)}`,
        CLASSIFY, 300);
      return { m, res: { kind: ['new_enquiry', 'reply', 'other'].includes(input?.kind) ? input.kind : 'other', summary: String(input?.summary ?? '').slice(0, 200) } };
    } catch (e) { failed ??= e; return { m, res: null }; }      // left for the next check
  });
  let screened = 0, found = 0;
  for (const { m, res } of looks) {
    if (!res) continue;
    if (res.kind === 'new_enquiry') found++;
    if (m.status === 'screen' && res.kind !== 'new_enquiry')
      // an unknown sender and not an enquiry: not kept
      await q(`update outlook_inbox set status = 'ignored', ai_kind = $2, ai_summary = null, ai_checked_at = now(), subject = null, body_excerpt = null,
          from_name = null, to_addrs = null, cc_addrs = null, web_link = null where id = $1`, [m.id, res.kind]);
    else
      await q(`update outlook_inbox set status = 'unmatched', ai_kind = $2, ai_summary = $3, ai_checked_at = now() where id = $1`, [m.id, res.kind, res.summary || null]);
    screened++;
  }
  if (!screened && failed) throw failed;
  const left = Number((await one(`select count(*) n from outlook_inbox where user_id = $1 and ai_checked_at is null and status in ('screen', 'unmatched')`, [actor.id]))!.n);
  return { screened, new_enquiries: found, left };
}

// ---------------------------------------------------------------- 2. the AI fills the enquiry
const EXTRACT = {
  name: 'enquiry_from_email',
  description: 'Fill a new freight enquiry from the customer\'s email.',
  input_schema: { type: 'object', properties: {
    company_name: { type: 'string', description: 'The customer company (from the signature or the email). Empty if not shown.' },
    contact_person: { type: 'string' }, contact_phone: { type: 'string', description: 'Phone from the signature, as written.' },
    mode: { type: 'string', enum: ['sea_fcl', 'sea_lcl', 'air', 'road', 'courier', 'other', 'unknown'] },
    incoterm: { type: 'string', description: '3-letter Incoterm if stated (EXW, FOB, CIF, DAP, DDP…), else empty.' },
    origin_country: { type: 'string', description: 'Country name where the cargo starts.' }, origin_port: { type: 'string', description: 'Port or airport of loading if named.' },
    origin_port_code: { type: 'string', description: 'The UN/LOCODE of that port or airport if you know it (e.g. INNSA for Nhava Sheva, AEJEA for Jebel Ali). Empty if unsure.' },
    destination_country: { type: 'string' }, destination_port: { type: 'string', description: 'Port or airport of discharge if named.' },
    destination_port_code: { type: 'string', description: 'The UN/LOCODE of that port or airport if you know it. Empty if unsure.' },
    pickup_address: { type: 'string', description: 'Full pickup / collection address if given.' }, delivery_address: { type: 'string' },
    cargo_description: { type: 'string', description: 'What the goods are.' },
    containers: { type: 'string', description: 'Containers asked for, e.g. "2x40HC".' }, packages: { type: 'string', description: 'Packages and sizes as written, e.g. "5 pallets 120x80x150 cm".' },
    cargo_lines: { type: 'array', description: 'The packing list: one line per package size (only lines with real numbers).', items: { type: 'object', properties: {
      package_type: { type: 'string', description: 'Cartons, Pallets, Crates, Wooden boxes, Drums, Bags, Bales, Rolls, Bundles, Pieces or Loose' },
      pieces: { type: 'number', description: 'Number of packages' }, length: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' },
      dim_unit: { type: 'string', enum: ['cm', 'in', 'm'] },
      weight_per_package_kg: { type: 'number' }, total_weight_kg: { type: 'number', description: 'Total weight of this line, if given' },
    }, required: ['pieces'] } },
    hs_codes: { type: 'array', items: { type: 'string' }, description: 'Every HS code mentioned (digits only, e.g. "64041100"). Each once.' },
    gross_weight_kg: { type: 'number', description: 'Total weight in kg if given (convert tons to kg).' },
    cargo_ready_date: { type: 'string', description: 'YYYY-MM-DD if given as a real date; empty otherwise.' }, hazardous: { type: 'string', enum: ['yes', 'no', 'unknown'] },
    stackable: { type: 'string', enum: ['yes', 'no', 'unknown'] }, insurance: { type: 'string', enum: ['yes', 'no', 'unknown'], description: 'Does the customer want cargo / marine insurance?' },
    cargo_value: { type: 'number', description: 'Invoice / cargo value as a number (e.g. 195635.14), if given.' },
    cargo_value_currency: { type: 'string', description: 'Currency of that value: AED, USD, EUR, INR or CNY.' },
    asked_services: { type: 'object', description: 'What the CUSTOMER asks us to do, from their own words (not what the Incoterm implies). "door to door" = pickup and delivery yes; "port to port" = pickup and delivery no; "we will clear ourselves" = clearance no. unknown when not said.',
      properties: { origin_pickup: { type: 'string', enum: ['yes', 'no', 'unknown'] }, export_clearance: { type: 'string', enum: ['yes', 'no', 'unknown'] }, freight: { type: 'string', enum: ['yes', 'no', 'unknown'] }, import_clearance: { type: 'string', enum: ['yes', 'no', 'unknown'] }, delivery: { type: 'string', enum: ['yes', 'no', 'unknown'] } } },
    cargo_ready_now: { type: 'boolean', description: 'true when they say the cargo is ready now (ready for collection / cargo ready / available for pickup) without a later date.' },
    general_cargo: { type: 'boolean', description: 'true when they call it general cargo / non-DG / non-hazardous.' },
    customer_remarks: { type: 'string', description: 'Remarks, special instructions or conditions the customer writes (e.g. fumigation needed, tail-lift truck, deliver before 10 Dec, insurance at 110%, payment terms), short, in their words. Empty if none.' },
    remark_impacts: { type: 'array', items: { type: 'string' }, description: 'For each remark that changes the price, the services or who is responsible: one short line saying how. Empty when none.' },
    conflicts: { type: 'array', items: { type: 'string' }, description: 'Things in the email that contradict each other or the Incoterm (e.g. FOB but asks pickup at the factory; two different weights). One short line each. Empty when none.' },
    summary: { type: 'string', description: 'One line: what the customer asks for.' },
  }, required: ['mode', 'hazardous', 'summary'] },
};

async function customerOf(email: string) {
  const e = email.toLowerCase();
  const exact = await one(`select c.id, c.name from customers c where lower(c.email) = $1 and c.deleted_at is null
    union all select c.id, c.name from customer_contacts k join customers c on c.id = k.customer_id where lower(k.email) = $1 and k.deleted_at is null and c.deleted_at is null
    limit 1`, [e]);
  if (exact) return exact;
  const d = e.split('@')[1];
  if (!d || PUBLIC.has(d)) return null;
  return one(`select c.id, c.name from customers c where lower(c.email) like $1 and c.deleted_at is null
    union all select c.id, c.name from customer_contacts k join customers c on c.id = k.customer_id where lower(k.email) like $1 and k.deleted_at is null and c.deleted_at is null
    limit 1`, [`%@${d}`]);
}
async function countryCode(name: unknown) {
  const n = String(name ?? '').trim().toLowerCase();
  if (!n) return null;
  const alias: Record<string, string> = { uae: 'AE', 'u.a.e': 'AE', dubai: 'AE', usa: 'US', 'u.s.a': 'US', uk: 'GB', 'united kingdom': 'GB', england: 'GB', china: 'CN', 'south korea': 'KR', korea: 'KR', russia: 'RU', vietnam: 'VN', turkey: 'TR', iran: 'IR' };
  if (alias[n]) return alias[n];
  return (await one(`select code from countries where lower(name) = $1 or code = upper($1) or lower(name) like $1 || ',%' or lower(name) like $1 || ' (%' limit 1`, [n]))?.code ?? null;
}
async function portOf(name: unknown, country: string | null, air: boolean, code?: unknown) {
  const kind = `($3::boolean and kind in ('air', 'both') or not $3::boolean and kind in ('sea', 'both', 'inland'))`;
  // 1. the official code the AI gave (e.g. INNSA), when it is in the list and in the right country
  const c = String(code ?? '').trim().toUpperCase();
  if (/^[A-Z]{2}[A-Z0-9]{3}$/.test(c)) {
    const p = await one(`select code, name, country_code from ports where is_active and code = $1 and ($2::text is null or country_code = $2) and ${kind}`, [c, country, air]);
    if (p) return p;
  }
  const n = String(name ?? '').trim().toLowerCase().replace(/\s+(port|seaport|sea port|airport|terminal)$/, '').replace(/^port of\s+/, '');
  if (!n) return null;
  // 2. the same name or a name that starts with it; 3. the name inside a longer one ("Jawaharlal Nehru (Nhava Sheva)") — same country first, bigger ports first
  return one(`select code, name, country_code from ports where is_active and ${kind}
      and (lower(code) = $1 or lower(iata) = $1 or lower(name) = $1 or lower(name) like $1 || '%' or lower(plain_name) like $1 || '%'
        or (length($1) >= 4 and (lower(name) like '%' || $1 || '%' or lower(plain_name) like '%' || $1 || '%')))
    order by coalesce(lower(code) = $1 or lower(iata) = $1 or lower(name) = $1, false) desc, coalesce(country_code = $2, false) desc,
      coalesce(lower(name) like $1 || '%', false) desc, weight desc limit 1`, [n, country, air]);
}

async function myWaiting(actor: Actor, id: string) {
  if (!isUuid(id)) throw notFound('Email');
  const m = await one('select * from outlook_inbox where id = $1 and user_id = $2', [id, actor.id]);
  if (!m) throw notFound('Email');
  return m;
}
/** Made into an enquiry already (from this inbox or another one that got the same email)? */
async function alreadyMade(m: any) {
  const r = await one(`select f.id, f.enquiry_ref from outlook_inbox o join job_files f on f.id = o.job_file_id
    where (o.id = $1 or ($2::text is not null and o.internet_message_id = $2)) and o.job_file_id is not null limit 1`, [m.id, m.internet_message_id]);
  return r ? { id: r.id, enquiry_ref: r.enquiry_ref } : null;
}

/** "Create enquiry": what the AI fills in from the whole email (read once, then kept). */
export async function draftEnquiry(actor: Actor, id: string) {
  if (!actor.has('jobfiles.create')) throw forbidden('You cannot open enquiries');
  const m = await myWaiting(actor, id);
  const made = await alreadyMade(m);
  if (made) return { already: made };
  if (m.status !== 'unmatched') throw bad('This email is already handled');
  // kept from before — unless it was read by an older version (then it is read again, once, with the newer reading)
  if (m.ai_draft && m.ai_draft.v === DRAFT_VERSION) return { draft: m.ai_draft, email: emailInfo(m) };
  await ensurePortsLoaded();
  const full: any = await graph(actor.id, `/me/messages/${encodeURIComponent(m.ms_message_id)}?$select=body`, { headers: { Prefer: 'outlook.body-content-type="text"' } })
    .catch((e) => { if (e instanceof ApiError && e.code === 'MS_GRAPH') return null; throw e; });
  const text = String(full?.body?.content ?? m.body_excerpt ?? '').replace(/\r\n/g, '\n').replace(/\n{3,}/g, '\n\n').slice(0, 12000);
  // the attachments too (customers often send the details in a sheet): Excel / CSV / Word as text, PDF / pictures as they are
  const att = m.has_attachments ? await readAttachments(actor.id, m.ms_message_id) : { blocks: [], text: '', notes: [], names: [] };
  const emailText = `From: ${m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr}\nSubject: ${m.subject ?? ''}\nReceived: ${m.received_at ? new Date(m.received_at).toISOString().slice(0, 10) : ''}\n\n${text}`
    + (att.text ? `\n\n--- Attached files (read them too: they often hold the shipment details) ---\n${att.text}` : '')
    + (att.blocks.length ? '\n\nThe attached PDF / pictures are included above: read them too.' : '');
  const { input: x } = await askWithTool(
    `You read a customer's email to Reliance Freight Systems, a freight forwarder in Dubai, UAE, and fill a new enquiry.
Use only what the email says; leave a field empty when it is not there. Never guess prices. Dates as YYYY-MM-DD (today is ${today()}; with no year use the next such date).
Read it like an experienced forwarding executive: "general cargo" means non-DG; "ready for collection" means ready now; read every remark and instruction, even outside the usual details.
"Dubai", "Jebel Ali", "Sharjah", "Abu Dhabi" and "UAE" are in the United Arab Emirates.`,
    att.blocks.length ? [...att.blocks, { type: 'text', text: emailText }] : emailText,
    EXTRACT, 1200, 9000);

  // the customer: existing (by email / company domain) or new from the signature
  const known = m.from_addr ? await customerOf(m.from_addr) : null;
  const domainName = (m.from_addr ?? '').split('@')[1]?.split('.')[0] ?? '';
  const newCustomer = known ? null : {
    name: String(x.company_name || '').trim().slice(0, 200) || (domainName && !PUBLIC.has((m.from_addr ?? '').split('@')[1]) ? domainName[0].toUpperCase() + domainName.slice(1) : '') || String(m.from_name ?? ''),
    contact_person: String(x.contact_person || m.from_name || '').trim().slice(0, 120) || null,
    email: m.from_addr, contact_number: String(x.contact_phone ?? '').replace(/[^+0-9 ()-]/g, '').trim().slice(0, 30) || null,
  };
  // the Salesman: the customer's main one; else the Salesman whose inbox it is, or who the customer wrote to
  let salesman: string | null = null;
  if (known) salesman = (await one(`select user_id from customer_salesmen where customer_id = $1 and is_main and removed_at is null`, [known.id]))?.user_id ?? null;
  if (!salesman) {
    const people = [String((await one('select email from users where id = $1', [actor.id]))?.email ?? ''), ...String(`${m.to_addrs ?? ''},${m.cc_addrs ?? ''}`).split(/,\s*/)]
      .map((e) => e.trim().toLowerCase()).filter(Boolean);
    salesman = (await one(`select u.id from users u join roles r on r.id = u.role_id where r.code = 'sales' and u.is_active and u.deleted_at is null
      and lower(u.email) = any($1) order by (u.id = $2) desc limit 1`, [people, actor.id]))?.id ?? null;
  }
  // places, mode, Incoterm
  const mode = ['sea_fcl', 'sea_lcl', 'air', 'road', 'courier', 'other'].includes(x.mode) ? x.mode : null;
  const air = mode === 'air';
  let oc = await countryCode(x.origin_country), dc = await countryCode(x.destination_country);
  const pol = await portOf(x.origin_port, oc, air, x.origin_port_code), pod = await portOf(x.destination_port, dc, air, x.destination_port_code);
  oc = oc ?? pol?.country_code ?? null; dc = dc ?? pod?.country_code ?? null;
  const direction = oc === HOME_COUNTRY ? 'export' : dc === HOME_COUNTRY ? 'import' : oc && dc ? 'cross_trade' : null;
  const inc = String(x.incoterm ?? '').toUpperCase().match(/\b[A-Z]{3}\b/)?.[0];
  // checklist answers the email gives (cargo ready date, DG)
  const checks = await q(`select id, label from enquiry_checks where is_active`).catch(() => []);
  const details: Record<string, string> = {};
  // 21 Nov, batch 1 — the operations rules (src/lib/opsRules.ts) settle what the email leaves to judgement
  const said = `${ownWords(text)}\n${att.text}`;                     // a forwarded / replied email: not the quoted part
  const flags: string[] = (Array.isArray(x.conflicts) ? x.conflicts : []).map((v: any) => String(v).slice(0, 300)).filter(Boolean).slice(0, 6);
  // cargo ready: the date they give, else today when they say it is ready now
  const dateGiven = /^\d{4}-\d{2}-\d{2}$/.test(String(x.cargo_ready_date ?? '')) ? x.cargo_ready_date : null;
  const readyNow = !!x.cargo_ready_now || saysReady(said);
  const ready = dateGiven ?? (readyNow ? today() : null);
  const readyConfirmed = readyNow && (!dateGiven || dateGiven <= today());
  const rc = checks.find((c: any) => /ready/i.test(c.label)); if (rc && ready) details[rc.id] = ready;
  // DG: "general cargo" = Non-DG; DG words = ask for the MSDS / UN number, never a silent "no"
  const dgRule = dgFromText(`${x.cargo_description ?? ''}\n${said}`);
  let haz: string | null = ['yes', 'no'].includes(x.hazardous) ? x.hazardous : null;
  if (dgRule.dg === 'check' && haz !== 'yes') { haz = null; flags.push(`DG words in the email (${dgRule.words.slice(0, 4).join(', ')}) — confirm DG or not, with the MSDS / UN number, before quoting.`); }
  else if ((x.general_cargo || dgRule.dg === 'no') && haz !== 'yes') haz = 'no';
  const dg = checks.find((c: any) => /hazard|\bdg\b/i.test(c.label)); if (dg && haz) details[dg.id] = haz;
  // FCL: stackable is never asked (kept only when they say it)
  const st = checks.find((c: any) => /stack/i.test(c.label)); if (st && x.mode !== 'sea_fcl' && ['yes', 'no'].includes(x.stackable)) details[st.id] = x.stackable;
  const cargo = [x.cargo_description, x.containers, x.packages].map((s) => String(s ?? '').trim()).filter(Boolean).join(' · ').slice(0, 500) || null;
  // the packing list → cargo lines (only lines that pass the same checks as the form)
  const lines = (Array.isArray(x.cargo_lines) ? x.cargo_lines : []).map((l: any) => {
    const t = String(l?.package_type ?? '').trim().toLowerCase();
    const type = PACKAGE_TYPES.find((p) => p.toLowerCase() === t || p.toLowerCase().replace(/s$/, '') === t.replace(/s$/, '') || (t && p.toLowerCase().startsWith(t.slice(0, 4))));
    const pieces = Math.round(Number(l?.pieces));
    const weight = Number(l?.total_weight_kg) > 0 ? Number(l.total_weight_kg) : Number(l?.weight_per_package_kg) > 0 ? Number(l.weight_per_package_kg) * pieces : 0;
    return { package_type: type ?? (t ? 'Other' : 'Cartons'), package_other: type ? '' : String(l?.package_type ?? '').slice(0, 40), pieces, length: Number(l?.length) || '',
      width: Number(l?.width) || '', height: Number(l?.height) || '', dim_unit: ['cm', 'in', 'm'].includes(l?.dim_unit) ? l.dim_unit : 'cm', weight_kg: Math.round(weight * 100) / 100 };
  }).filter((l: any) => !lineProblem(l)).slice(0, 20);
  // every HS code, once
  const hsCodes = [...new Set((Array.isArray(x.hs_codes) ? x.hs_codes : []).map((h: any) => String(h).replace(/[^0-9]/g, '')).filter((h: string) => h.length >= 4 && h.length <= 12))];
  const hs = checks.find((c: any) => /hs\s*code/i.test(c.label)); if (hs && hsCodes.length) details[hs.id] = hsCodes.join(', ');
  // services: the Incoterm's default, the customer's own words win, clashes flagged
  const incoterm = inc && INCOTERMS.includes(inc) ? inc : null;
  const yn = (v: any) => (['yes', 'no'].includes(v) ? v : 'unknown');
  const a = x.asked_services ?? {};
  const svc = decideServices({ incoterm, direction, pickup_address: x.pickup_address, delivery_address: x.delivery_address,
    asked: { origin_pickup: yn(a.origin_pickup), export_clearance: yn(a.export_clearance), freight: yn(a.freight), import_clearance: yn(a.import_clearance), delivery: yn(a.delivery), insurance: yn(x.insurance) } });
  const ins = checks.find((c: any) => /insur/i.test(c.label)); if (ins && svc.insurance) details[ins.id] = svc.insurance;
  // remarks: what the customer wrote, kept and highlighted when it changes price / services / responsibility
  const remarks = [String(x.customer_remarks ?? '').trim().slice(0, 1500), readyConfirmed ? READY_REMARK : ''].filter(Boolean).join('\n') || null;
  const impacts = (Array.isArray(x.remark_impacts) ? x.remark_impacts : []).map((v: any) => String(v).slice(0, 300)).filter(Boolean).slice(0, 6);
  const draft = {
    status: 'enquiry', customer_id: known?.id ?? null, customer_name: known?.name ?? null, new_customer: newCustomer, salesman_id: salesman,
    division: direction === 'export' ? 'exports' : direction === 'import' ? 'imports' : direction === 'cross_trade' ? 'cross_trade' : null,
    direction, mode: mode ?? 'sea_fcl', incoterm,
    ...(svc.needs_clearance !== null ? { needs_clearance: svc.needs_clearance } : {}), ...(svc.needs_transport !== null ? { needs_transport: svc.needs_transport } : {}),
    cargo_ready_confirmed: readyConfirmed, remarks,
    ai_notes: { services: svc.reasons, flags: [...svc.flags, ...flags], remarks: impacts },
    origin_country: oc, destination_country: dc,
    port_of_loading: pol?.name ?? (String(x.origin_port ?? '').trim() || null), pol_code: pol?.code ?? null,
    port_of_discharge: pod?.name ?? (String(x.destination_port ?? '').trim() || null), pod_code: pod?.code ?? null,
    pickup_address: String(x.pickup_address ?? '').trim() || null, delivery_address: String(x.delivery_address ?? '').trim() || null,
    cargo_description: cargo, gross_weight_kg: Number(x.gross_weight_kg) > 0 ? Number(x.gross_weight_kg) : lines.length ? cargoTotals(lines).weight : null,
    cargo_lines: lines.length ? lines : undefined, hs_codes: hsCodes,
    packages: lines.length ? undefined : packagesFrom(cargo) ?? undefined,   // 27 Nov: "40 pallets (20 per container)" with no sizes
    cargo_value: Number(x.cargo_value) > 0 ? Math.round(Number(x.cargo_value) * 100) / 100 : null,
    cargo_value_currency: Number(x.cargo_value) > 0 && ['AED', 'USD', 'EUR', 'INR', 'CNY'].includes(String(x.cargo_value_currency ?? '').toUpperCase()) ? String(x.cargo_value_currency).toUpperCase() : null,
    enquiry_details: Object.keys(details).length ? details : undefined,
    summary: String(x.summary ?? '').slice(0, 300), mode_unknown: !mode,
    attachments_read: att.names, attachments_notes: att.notes, v: DRAFT_VERSION,
  };
  await q('update outlook_inbox set ai_draft = $2 where id = $1', [m.id, JSON.stringify(draft)]);
  return { draft, email: emailInfo(m) };
}
const emailInfo = (m: any) => ({ id: m.id, from_name: m.from_name, from_addr: m.from_addr, subject: m.subject, received_at: m.received_at, web_link: m.web_link, summary: m.ai_summary });

// ---------------------------------------------------------------- 3. Save: customer (when new) + enquiry + the email filed

/**
 * A new customer typed on an enquiry (from an email, or chosen as "New customer" / "Walk-in customer" on New enquiry).
 * Anyone who may open enquiries may add one. Never a duplicate: a company with the same name is used as it is; a walk-in
 * (a person, no company) with the same name and the same mobile is used, with another mobile it is refused.
 */
export async function addCustomer(c: any, actor: Actor, nc: any, salesmanId: unknown, how: string): Promise<{ id: string; created: string | null }> {
  const walkIn = !!nc?.walk_in;
  const need = (k: string, m: string) => { throw new ApiError(400, 'VALIDATION', m, { fields: { [k]: m } }); };
  if (!String(nc?.name ?? '').trim()) need('new_customer_name', walkIn ? 'Enter the person\'s name' : 'Enter the company name');
  if (walkIn && !String(nc?.contact_number ?? '').trim()) need('new_customer_phone', 'Enter the mobile number');
  if (!actor.isSuperAdmin && !actor.has('customers.manage') && !actor.has('jobfiles.create')) throw forbidden('You cannot add customers — choose an existing one');
  const f = (k: string) => MASTERS.customers.fields.find((x) => x.key === k)!;
  const vals = { name: parseField(f('name'), nc.name), contact_person: parseField(f('contact_person'), walkIn ? nc.name : nc.contact_person),
    contact_number: parseField(f('contact_number'), nc.contact_number), email: parseField(f('email'), nc.email) } as Record<string, any>;
  const ex = await one('select id, contact_number from customers where lower(name) = lower($1) and deleted_at is null', [vals.name], c);
  if (ex) {
    const digits = (v: unknown) => String(v ?? '').replace(/\D/g, '').slice(-9);
    if (walkIn && digits(ex.contact_number) !== digits(vals.contact_number))
      need('new_customer_name', `A customer named "${vals.name}" is already in RFS CRM with another number. Choose it from the list, or add something to the name (e.g. the area).`);
    return { id: ex.id, created: null };                                   // same name already there: use it, never a duplicate
  }
  const id = (await one(`insert into customers (name, contact_person, contact_number, email, remarks, is_active) values ($1,$2,$3,$4,$5,true) returning id`,
    [vals.name, vals.contact_person, vals.contact_number, vals.email, walkIn ? 'Walk-in customer (person, no company)' : null], c))!.id;
  if (vals.email || vals.contact_number) await c.query(`insert into customer_contacts (customer_id, full_name, email, mobile, is_primary, email_as) values ($1, $2, $3, $4, true, $5)`,
    [id, vals.contact_person || vals.name, vals.email, vals.contact_number, vals.email ? 'to' : null]);
  const owner = isUuid(salesmanId) ? salesmanId : actor.role_code === 'sales' ? actor.id : null;
  if (owner) await c.query(`insert into customer_salesmen (customer_id, user_id, is_main, created_by) values ($1, $2, true, $3) on conflict do nothing`, [id, owner, actor.id]);
  await audit(c, actor, { entity_type: 'customers', entity_id: id, action: walkIn ? `${how} — walk-in` : how, new_value: vals.name });
  return { id, created: vals.name };
}

/** New enquiry / Job File from the form: when "New customer" or "Walk-in customer" was chosen, the customer is added first (same save). */
export async function createWithCustomer(actor: Actor, b: any) {
  const { new_customer: nc, history_used: used, ...e } = b ?? {};
  const { logUsedHints } = await import('./history');                     // migration 038: past-job suggestions used on the form
  return tx(async (c) => {
    if (isUuid(e.customer_id) || !nc) { const jf = await createJobFile(actor, e, c); await logUsedHints(c, actor, jf.id, used); return jf; }
    const r = await addCustomer(c, actor, nc, e.salesman_id, 'Customer created on New enquiry');
    const jf = await createJobFile(actor, { ...e, customer_id: r.id }, c);
    return { ...jf, customer_created: r.created };
  });
}
export async function createFromEmail(actor: Actor, id: string, b: any) {
  const m = await myWaiting(actor, id);
  const made = await alreadyMade(m);
  if (made) throw new ApiError(409, 'JOB_FILE_EXISTS', `This email is already enquiry ${made.enquiry_ref}`, { id: made.id });
  if (m.status !== 'unmatched') throw bad('This email is already handled');
  const e = { ...(b?.enquiry ?? {}), status: 'enquiry' };
  const nc = b?.new_customer;
  return tx(async (c) => {
    await c.query('select id from outlook_inbox where id = $1 for update', [m.id]);
    let customerId: string | null = isUuid(e.customer_id) ? e.customer_id : null;
    let created: string | null = null;
    if (!customerId) {
      const r = await addCustomer(c, actor, nc, e.salesman_id, 'Customer created from an email (AI, checked)');
      customerId = r.id; created = r.created;
    }
    const jf = await createJobFile(actor, { ...e, customer_id: customerId }, c);
    // the email, in every inbox it came to, is filed on the new enquiry (later replies follow it)
    await fileOnShipment(c, actor, jf.id, m, 'hand');
    await c.query(`update outlook_inbox set status = 'filed', job_file_id = $2, matched_by = 'new enquiry', handled_by = $3, handled_at = now()
      where id = $1 or ($4::text is not null and internet_message_id = $4 and status <> 'filed')`, [m.id, jf.id, actor.id, m.internet_message_id]);
    return { id: jf.id, enquiry_ref: jf.enquiry_ref, customer_created: created };
  }).then(async (r) => ({ ...r, ack: await sendAck(actor, r.id).catch((err: any) => ({ sent: false, error: String(err?.message ?? err) })) }));
}

/**
 * 26 Nov — "Enquiry received": sent by itself, once, from the person's own Outlook, to the address the enquiry email came from,
 * when they save a new enquiry made from that email (only then — never for other enquiries). Their signature picture is added
 * by sendMail. Kept on the enquiry's Emails tab and history. If sending fails, the enquiry says so and offers Retry.
 */
export async function sendAck(actor: Actor, fileId: string) {
  if (!isUuid(fileId)) throw notFound('Job File');
  const f = await one(`select f.id, f.enquiry_ref, f.ack_sent_at, f.status, c.name customer_name from job_files f left join customers c on c.id = f.customer_id where f.id = $1`, [fileId]);
  if (!f) throw notFound('Job File');
  const { canEdit, loadFile, event } = await import('./jobfiles');
  if (!canEdit(actor, await loadFile(actor, fileId))) throw forbidden();
  if (f.ack_sent_at) return { sent: true, already: true };
  // the enquiry email it was made from (filed on it when saved)
  const src = await one(`select from_addr, from_name, message_id from email_messages where job_file_id = $1 and direction = 'in' and from_addr is not null order by coalesce(sent_at, created_at) limit 1`, [fileId]);
  if (!src) return { sent: false, error: 'No customer email on this enquiry' };
  const name = String(src.from_name ?? '').trim() || f.customer_name || 'Sir / Madam';
  const subject = `Enquiry Received – ${f.enquiry_ref}`;
  const text = `Dear ${name},\n\nThank you for your enquiry.\n\nWe have received your request and are currently coordinating with our agents and carriers to obtain the best possible rates.\n\nWe will share our quotation with you at the earliest.\n\nThank you for considering us.\n\nBest Regards,\n${actor.full_name}`;
  try {
    const { sendMail } = await import('./outlook');
    const sent = await sendMail(actor.id, { to: [src.from_addr], subject, body: text, replyTo: src.message_id });   // 27 Nov: in the customer's own thread
    await tx(async (c) => {
      const won = await c.query('update job_files set ack_sent_at = now(), ack_error = null where id = $1 and ack_sent_at is null', [fileId]);
      if (!won.rowCount) return;                                          // sent at the same moment by a second click: kept once
      await c.query(`insert into email_messages (job_file_id, direction, status, template_key, from_addr, from_name, to_addrs, subject, sent_at, body_excerpt, source, created_by, created_by_name)
        values ($1, 'out', 'sent', 'enquiry_ack', $2, $3, $4, $5, now(), $6, 'button', $7, $3)`, [fileId, sent.from, actor.full_name, sent.to.join(', '), subject, text.slice(0, 2000), actor.id]);
      await event(c, actor, fileId, { kind: 'note', title: 'Acknowledgement sent to the customer (automatic)', new_value: `To ${sent.to.join(', ')} — "${subject}"` });
    });
    return { sent: true, to: src.from_addr };
  } catch (e: any) {
    const msg = String(e?.message ?? e).slice(0, 300);
    await q('update job_files set ack_error = $2 where id = $1 and ack_sent_at is null', [fileId, msg]);
    return { sent: false, error: msg };
  }
}
