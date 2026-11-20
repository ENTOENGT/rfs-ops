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
import { INCOTERMS } from '../lib/jobfileRules';
import { PACKAGE_TYPES, cargoTotals, lineProblem } from '../lib/cargoRules';

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const PUBLIC = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'icloud.com', 'aol.com', 'msn.com', 'yandex.com', 'proton.me', 'protonmail.com']);
/** Raised when the reading gets better (attachments, cargo lines, HS codes…): drafts kept from before are read again once. */
const DRAFT_VERSION = 3;
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
export async function screenInbox(actor: Actor, max = 4) {
  if (!aiConfig().ready) return { screened: 0, off: true };
  const rows = await q(`select * from outlook_inbox where user_id = $1 and ai_checked_at is null and status in ('screen', 'unmatched')
    order by received_at desc nulls last limit $2`, [actor.id, Math.min(10, Math.max(1, max))]);
  let screened = 0, found = 0;
  for (const m of rows) {
    // the same email in another inbox (Salesman and Coordinator): use that look
    let res = m.internet_message_id ? await one(`select ai_kind kind, ai_summary summary from outlook_inbox
      where internet_message_id = $1 and id <> $2 and ai_checked_at is not null and ai_kind is not null limit 1`, [m.internet_message_id, m.id]) : null;
    if (!res) {
      try {
        const { input } = await askWithTool(
          'You sort the inbox of a salesman at Reliance Freight Systems, a freight forwarder in Dubai. Decide what kind of email this is. Judge only from what is shown.',
          `From: ${m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr}${m.known_as ? ` (${m.known_as})` : ' (not a known customer yet)'}\nSubject: ${m.subject ?? ''}${m.has_attachments ? '\nHas attachments: yes' : ''}\n\n${String(m.body_excerpt ?? '').slice(0, 1000)}`,
          CLASSIFY, 300);
        res = { kind: ['new_enquiry', 'reply', 'other'].includes(input?.kind) ? input.kind : 'other', summary: String(input?.summary ?? '').slice(0, 200) };
      } catch (e) { if (screened) break; throw e; }
    }
    if (res.kind === 'new_enquiry') found++;
    if (m.status === 'screen' && res.kind !== 'new_enquiry')
      // an unknown sender and not an enquiry: not kept
      await q(`update outlook_inbox set status = 'ignored', ai_kind = $2, ai_summary = null, ai_checked_at = now(), subject = null, body_excerpt = null,
          from_name = null, to_addrs = null, cc_addrs = null, web_link = null where id = $1`, [m.id, res.kind]);
    else
      await q(`update outlook_inbox set status = 'unmatched', ai_kind = $2, ai_summary = $3, ai_checked_at = now() where id = $1`, [m.id, res.kind, res.summary || null]);
    screened++;
  }
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
  const ready = /^\d{4}-\d{2}-\d{2}$/.test(String(x.cargo_ready_date ?? '')) ? x.cargo_ready_date : null;
  const rc = checks.find((c: any) => /ready/i.test(c.label)); if (rc && ready) details[rc.id] = ready;
  const dg = checks.find((c: any) => /hazard|\bdg\b/i.test(c.label)); if (dg && ['yes', 'no'].includes(x.hazardous)) details[dg.id] = x.hazardous;
  const st = checks.find((c: any) => /stack/i.test(c.label)); if (st && ['yes', 'no'].includes(x.stackable)) details[st.id] = x.stackable;
  const ins = checks.find((c: any) => /insur/i.test(c.label)); if (ins && ['yes', 'no'].includes(x.insurance)) details[ins.id] = x.insurance;
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
  const draft = {
    status: 'enquiry', customer_id: known?.id ?? null, customer_name: known?.name ?? null, new_customer: newCustomer, salesman_id: salesman,
    division: direction === 'export' ? 'exports' : direction === 'import' ? 'imports' : direction === 'cross_trade' ? 'cross_trade' : null,
    direction, mode: mode ?? 'sea_fcl', incoterm: inc && INCOTERMS.includes(inc) ? inc : null,
    origin_country: oc, destination_country: dc,
    port_of_loading: pol?.name ?? (String(x.origin_port ?? '').trim() || null), pol_code: pol?.code ?? null,
    port_of_discharge: pod?.name ?? (String(x.destination_port ?? '').trim() || null), pod_code: pod?.code ?? null,
    pickup_address: String(x.pickup_address ?? '').trim() || null, delivery_address: String(x.delivery_address ?? '').trim() || null,
    cargo_description: cargo, gross_weight_kg: Number(x.gross_weight_kg) > 0 ? Number(x.gross_weight_kg) : lines.length ? cargoTotals(lines).weight : null,
    cargo_lines: lines.length ? lines : undefined, hs_codes: hsCodes,
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
  const { new_customer: nc, ...e } = b ?? {};
  if (isUuid(e.customer_id) || !nc) return createJobFile(actor, e);
  return tx(async (c) => {
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
  });
}
