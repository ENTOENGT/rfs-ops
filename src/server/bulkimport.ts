/**
 * Bulk upload of customers and vendors from the Excel template (four sheets: Customers, Customer contacts, Vendors,
 * Vendor coverage). Two steps with the same rules: "Check" reads the file and says, row by row, what would happen
 * (new / already there / problem) without saving anything; "Import" saves the good rows in one go.
 *
 * Never a duplicate: a customer or vendor whose name (or customer code) already exists is matched, not created again —
 * only its empty fields are filled, and a contact whose email is already on that customer is skipped.
 * A customer's main Salesman is set only when it has none (changing owners stays with the Commercials Manager).
 */
import { Actor } from './auth';
import { audit, bad, forbidden, q, tx } from './db';
import { MASTERS, VENDOR_TYPES } from '../lib/masters';
import { parseField } from './masters';
import { ensurePortsLoaded } from './ports';
import { canManageCoverage } from './agents';

export const MAX_ROWS = 1000;
const SHEETS = { customers: 'Customers', contacts: 'Customer contacts', vendors: 'Vendors', coverage: 'Vendor coverage' } as const;
const COLS = {
  customers: ['Customer name*', 'Code', 'TRN', 'Main salesman (email)', 'Other salesmen (emails, commas)', 'Email', 'Contact person', 'Contact number', 'Address', 'Standing instructions', 'Remarks'],
  contacts: ['Customer name*', 'Contact name*', 'Role', 'Mobile', 'Email', 'Main contact (Yes/No)', 'On emails (To / CC / Not by default)', 'Remarks'],
  vendors: ['Vendor name*', 'Type*', 'TRN', 'Contact person', 'Contact number', 'Email', 'Address', 'Remarks'],
  coverage: ['Vendor name*', 'Covers* (Port / Country / Region)', 'Where* (port code, country or region name)', 'Modes (FCL, LCL, Air, Road, Courier — empty = all)', 'Side (Origin / Destination / Both)', 'Priority (Preferred / Normal / Backup)', 'Note'],
};
const MODE_WORDS: Record<string, string> = { fcl: 'sea_fcl', 'sea fcl': 'sea_fcl', lcl: 'sea_lcl', 'sea lcl': 'sea_lcl', air: 'air', road: 'road', courier: 'courier' };
const lc = (s: unknown) => String(s ?? '').trim().toLowerCase();

export type RowResult = { row: number; name: string; status: 'new' | 'exists' | 'problem'; note: string };
type Sheet = { name: string; rows: RowResult[] };

// ---------------------------------------------------------------- the template
export async function template(actor: Actor) {
  if (!actor.has('customers.manage') && !actor.has('vendors.manage') && !actor.isSuperAdmin) throw forbidden();
  await ensurePortsLoaded();
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  wb.creator = 'RFS CRM';
  const read = wb.addWorksheet('Read me');
  read.columns = [{ width: 110 }];
  for (const line of [
    'RFS CRM — bulk upload of customers and vendors',
    '',
    'Fill in the sheets you need and leave the others empty. Columns with * are required. Do not change the column headings.',
    'Then: Administration → Bulk upload → choose this file → Check. You see, row by row, what will happen. Nothing is saved until you press Import.',
    '',
    'Customers: one row per customer. Main salesman: the salesman\'s email in RFS CRM (see the Lists sheet). Other salesmen: emails separated by commas.',
    '   A customer whose name or code is already in RFS CRM is not added again: only its empty fields are filled in.',
    '   Its main salesman is set only if it has none yet.',
    'Customer contacts: one row per person. "Customer name" must be in the Customers sheet or already in RFS CRM.',
    '   On emails: To = always in To, CC = always in CC, Not by default = offered but not ticked. A contact whose email is already there is skipped.',
    'Vendors: one row per vendor. Type: choose from the list (Shipping line, Airline, Freight agent, Overseas agent, …).',
    'Vendor coverage: where each agent works — one row per port, country or region.',
    '   Covers = Port → Where = the port code (e.g. DEHAM for Hamburg, INMAA for Chennai). Covers = Country → Where = the country name (e.g. Germany).',
    '   Covers = Region → Where = the region name from Commercials → Ports & regions (e.g. North Europe).',
    '',
    `Up to ${MAX_ROWS} rows per sheet in one file.`,
  ]) read.addRow([line]);
  read.getRow(1).font = { bold: true, size: 14 };
  // lists for the drop-downs
  const lists = wb.addWorksheet('Lists');
  const salesmen = await q(`select u.full_name, u.email from users u join roles r on r.id = u.role_id where r.code = 'sales' and u.is_active and u.deleted_at is null order by u.full_name`);
  const regions = await q('select name from regions where is_active order by name');
  const cols: [string, string[]][] = [
    ['Salesmen (email)', salesmen.map((s) => s.email)], ['Salesman name', salesmen.map((s) => s.full_name)],
    ['Vendor types', VENDOR_TYPES.map((o) => o.label)], ['Yes / No', ['Yes', 'No']], ['On emails', ['To', 'CC', 'Not by default']],
    ['Covers', ['Port', 'Country', 'Region']], ['Side', ['Both', 'Origin', 'Destination']], ['Priority', ['Preferred', 'Normal', 'Backup']],
    ['Regions', regions.map((r) => r.name)],
  ];
  cols.forEach(([h, vals], i) => { lists.getCell(1, i + 1).value = h; lists.getCell(1, i + 1).font = { bold: true }; vals.forEach((v, j) => { lists.getCell(j + 2, i + 1).value = v; }); lists.getColumn(i + 1).width = 28; });
  const ref = (i: number, n: number) => `Lists!$${String.fromCharCode(65 + i)}$2:$${String.fromCharCode(65 + i)}$${Math.max(2, n + 1)}`;
  const add = (key: keyof typeof COLS, drops: Record<number, string>) => {
    const ws = wb.addWorksheet(SHEETS[key]);
    ws.addRow(COLS[key]);
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0F2A4A' } };
    ws.columns.forEach((c, i) => { c.width = Math.min(45, Math.max(16, COLS[key][i].length + 4)); });
    ws.views = [{ state: 'frozen', ySplit: 1 }];
    for (const [col, formula] of Object.entries(drops))
      for (let r = 2; r <= MAX_ROWS + 1; r++) ws.getCell(r, Number(col)).dataValidation = { type: 'list', allowBlank: true, formulae: [formula] };
  };
  add('customers', { 4: ref(0, salesmen.length) });
  add('contacts', { 6: ref(3, 2), 7: ref(4, 3) });
  add('vendors', { 2: ref(2, VENDOR_TYPES.length) });
  add('coverage', { 2: ref(5, 3), 5: ref(6, 3), 6: ref(7, 3) });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------------------------------------------------------- reading the file
function cellText(v: any): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    if (v instanceof Date) return v.toISOString().slice(0, 10);
    if ('text' in v) return String(v.text ?? '');                       // hyperlink (emails)
    if ('richText' in v) return v.richText.map((t: any) => t.text).join('');
    if ('result' in v) return String(v.result ?? '');                   // formula
    return '';
  }
  return String(v);
}
async function readBook(buf: Buffer) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as any); } catch { throw bad('This is not an Excel file (.xlsx). Download the template and fill that in.'); }
  const out: Record<keyof typeof SHEETS, { row: number; v: Record<string, string> }[]> = { customers: [], contacts: [], vendors: [], coverage: [] };
  for (const key of Object.keys(SHEETS) as (keyof typeof SHEETS)[]) {
    const ws = wb.getWorksheet(SHEETS[key]);
    if (!ws) continue;
    const head: string[] = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { head[i] = lc(cellText(c.value)).replace(/\*/g, '').trim(); });
    const want = COLS[key].map((h) => lc(h).replace(/\*/g, '').trim());
    const pos = want.map((h) => head.indexOf(h));
    if (pos[0] < 0) throw bad(`The sheet "${SHEETS[key]}" has changed column headings. Download a fresh template.`);
    ws.eachRow({ includeEmpty: false }, (r, n) => {
      if (n === 1) return;
      const v: Record<string, string> = {};
      want.forEach((h, i) => { v[h] = pos[i] > 0 ? cellText(r.getCell(pos[i]).value).trim() : ''; });
      if (Object.values(v).some((x) => x)) out[key].push({ row: n, v });
    });
    if (out[key].length > MAX_ROWS) throw bad(`"${SHEETS[key]}" has ${out[key].length} rows — up to ${MAX_ROWS} per file. Split it into smaller files.`);
  }
  return out;
}
const col = (key: keyof typeof COLS, i: number) => lc(COLS[key][i]).replace(/\*/g, '').trim();

// ---------------------------------------------------------------- check (and import)
/** Check the file (apply = false) or import it (apply = true). Both give the same row-by-row result. */
export async function bulkUpload(actor: Actor, b: any, apply: boolean) {
  const canCust = actor.isSuperAdmin || actor.has('customers.manage');
  const canVend = actor.isSuperAdmin || actor.has('vendors.manage');
  if (!canCust && !canVend) throw forbidden();
  const isManager = actor.isSuperAdmin || actor.has('commercial.manage');
  const raw = String(b?.file ?? '');
  if (!raw) throw bad('Choose the Excel file');
  const buf = Buffer.from(raw.replace(/^data:[^,]*,/, ''), 'base64');
  if (buf.length > 5 * 1024 * 1024) throw bad('The file is bigger than 5 MB. Split it into smaller files.');
  const data = await readBook(buf);
  if (!Object.values(data).some((x) => x.length)) throw bad('The file has no rows to upload. Fill in the template first.');
  await ensurePortsLoaded();

  // everything needed to check, loaded once
  const custs = await q(`select id, name, code, trn, email, contact_person, contact_number, address, service_instructions, remarks from customers where deleted_at is null`);
  const byName = new Map(custs.map((c) => [lc(c.name), c])), byCode = new Map(custs.filter((c) => c.code).map((c) => [lc(c.code), c]));
  const owners = await q(`select customer_id, user_id, is_main from customer_salesmen where removed_at is null`);
  const sales = await q(`select u.id, lower(u.email) email, lower(u.full_name) full_name, u.full_name name from users u join roles r on r.id = u.role_id
    where r.code = 'sales' and u.is_active and u.deleted_at is null`);
  const findSales = (s: string) => sales.find((x) => x.email === lc(s) || x.full_name === lc(s));
  const contacts = await q(`select customer_id, lower(email) email, is_primary from customer_contacts where deleted_at is null`);
  const vends = await q(`select id, name, vendor_type, trn, contact_person, contact_number, email, address, remarks from vendors where deleted_at is null`);
  const vByName = new Map(vends.map((v) => [String(v.name).trim().toUpperCase(), v]));
  const countries = await q('select code, lower(name) name from countries');
  const regions = await q('select id, lower(name) name from regions where is_active');
  const coverage = await q('select vendor_id, scope, port_code, country_code, region_id from agent_coverage');
  const custDef = MASTERS.customers, vendDef = MASTERS.vendors;
  const field = (d: typeof custDef, k: string) => d.fields.find((f) => f.key === k)!;

  const sheets: Sheet[] = [];
  const plan = { newCust: [] as any[], fillCust: [] as any[], owners: [] as any[], contacts: [] as any[], newVend: [] as any[], fillVend: [] as any[], coverage: [] as any[] };
  const fileCust = new Map<string, { key: string }>();       // customers in this file (by lower name) → key used to link
  const fileVend = new Map<string, true>();

  // ---- customers
  if (data.customers.length) {
    const rows: RowResult[] = [];
    if (!canCust) for (const r of data.customers) rows.push({ row: r.row, name: r.v[col('customers', 0)], status: 'problem', note: 'You cannot add customers' });
    else for (const { row, v } of data.customers) {
      const name = v[col('customers', 0)];
      try {
        const vals: Record<string, any> = {};
        for (const [i, k] of [[0, 'name'], [1, 'code'], [2, 'trn'], [5, 'email'], [6, 'contact_person'], [7, 'contact_number'], [8, 'address'], [9, 'service_instructions'], [10, 'remarks']] as [number, string][])
          vals[k] = parseField(field(custDef, k), v[col('customers', i)]);
        if (fileCust.has(lc(name))) throw bad('This customer is listed twice in the file');
        let main = v[col('customers', 3)] ? findSales(v[col('customers', 3)]) : null;
        if (v[col('customers', 3)] && !main) throw bad(`"${v[col('customers', 3)]}" is not an active Salesman (use their email from the Lists sheet)`);
        if (!main && actor.role_code === 'sales') main = sales.find((x) => x.id === actor.id) ?? null;
        if (main && main.id !== actor.id && !isManager) throw bad('Only the Commercials Manager gives customers to other Salesmen');
        const others = v[col('customers', 4)].split(/[,;]+/).map((x) => x.trim()).filter(Boolean).map((x) => { const s = findSales(x); if (!s) throw bad(`"${x}" is not an active Salesman`); return s; });
        if (others.length && !isManager) throw bad('Only the Commercials Manager adds more Salesmen to a customer');
        const ex = byName.get(lc(name)) ?? (vals.code ? byCode.get(lc(vals.code)) : undefined);
        const notes: string[] = [];
        if (ex) {
          const fill: Record<string, any> = {};
          for (const k of Object.keys(vals)) if (k !== 'name' && vals[k] !== null && (ex[k] === null || ex[k] === '')) fill[k] = vals[k];
          if (fill.code && byCode.has(lc(fill.code))) throw bad(`The code ${fill.code} is already used by ${byCode.get(lc(fill.code))!.name}`);
          if (Object.keys(fill).length) { plan.fillCust.push({ id: ex.id, ...fill }); notes.push(`fills ${Object.keys(fill).map((k) => field(custDef, k).label.toLowerCase()).join(', ')}`); }
          const hasMain = owners.some((o) => o.customer_id === ex.id && o.is_main);
          if (main && !hasMain) { plan.owners.push({ cust: ex.id, user: main.id, main: true }); notes.push(`main salesman ${main.name}`); }
          else if (main && hasMain && !owners.some((o) => o.customer_id === ex.id && o.is_main && o.user_id === main!.id)) notes.push('main salesman stays as it is (change it under Contacts & Salesmen)');
          for (const o of others) if (!owners.some((x) => x.customer_id === ex.id && x.user_id === o.id) && o.id !== main?.id) { plan.owners.push({ cust: ex.id, user: o.id, main: false }); notes.push(`adds salesman ${o.name}`); }
          fileCust.set(lc(name), { key: ex.id });
          rows.push({ row, name: ex.name, status: 'exists', note: notes.length ? `Already in RFS CRM — ${notes.join('; ')}` : 'Already in RFS CRM — nothing to change' });
        } else {
          if (vals.code && byCode.has(lc(vals.code))) throw bad(`The code ${vals.code} is already used by ${byCode.get(lc(vals.code))!.name}`);
          if (vals.code && plan.newCust.some((c) => lc(c.code) === lc(vals.code))) throw bad(`The code ${vals.code} is used twice in the file`);
          const key = `newc:${lc(name)}`;
          plan.newCust.push({ key, ...vals, is_active: true });
          if (main) plan.owners.push({ cust: key, user: main.id, main: true });
          for (const o of others) if (o.id !== main?.id) plan.owners.push({ cust: key, user: o.id, main: false });
          fileCust.set(lc(name), { key });
          rows.push({ row, name, status: 'new', note: [main ? `main salesman ${main.name}` : 'no salesman yet', others.length ? `+ ${others.map((o) => o.name).join(', ')}` : ''].filter(Boolean).join(' ') });
        }
      } catch (e: any) { rows.push({ row, name: name || '(no name)', status: 'problem', note: e.message }); }
    }
    sheets.push({ name: SHEETS.customers, rows });
  }

  // ---- customer contacts
  if (data.contacts.length) {
    const rows: RowResult[] = [];
    const seen = new Set<string>();
    const primarySet = new Set<string>();
    for (const { row, v } of data.contacts) {
      const cname = v[col('contacts', 0)], who = v[col('contacts', 1)];
      try {
        if (!canCust) throw bad('You cannot change customers');
        if (!cname) throw bad('Customer name is required');
        if (!who) throw bad('Contact name is required');
        const target = fileCust.get(lc(cname))?.key ?? byName.get(lc(cname))?.id;
        if (!target) throw bad(`"${cname}" is not in the Customers sheet or in RFS CRM`);
        const email = v[col('contacts', 4)] ? String(parseField({ key: 'email', label: 'Email', type: 'email' } as any, v[col('contacts', 4)])) : null;
        const mobile = v[col('contacts', 3)] ? String(parseField({ key: 'mobile', label: 'Mobile', type: 'phone', max: 30 } as any, v[col('contacts', 3)])) : null;
        if (who.length > 120) throw bad('Contact name is too long');
        const yes = lc(v[col('contacts', 5)]);
        if (yes && !['yes', 'no', 'y', 'n'].includes(yes)) throw bad('Main contact: Yes or No');
        const asRaw = lc(v[col('contacts', 6)]);
        const emailAs = !asRaw ? null : asRaw === 'to' ? 'to' : asRaw === 'cc' ? 'cc' : asRaw.startsWith('not') || asRaw === 'none' ? 'none' : (() => { throw bad('On emails: To, CC or Not by default'); })();
        const dupKey = `${target}|${email ?? lc(who)}`;
        if (seen.has(dupKey)) throw bad('This contact is listed twice in the file');
        seen.add(dupKey);
        if (email && contacts.some((k) => k.customer_id === target && k.email === email)) { rows.push({ row, name: `${who} (${cname})`, status: 'exists', note: 'This email is already a contact of the customer — skipped' }); continue; }
        let primary = yes.startsWith('y');
        const note: string[] = [];
        if (primary && (primarySet.has(target) || contacts.some((k) => k.customer_id === target && k.is_primary))) { primary = false; note.push('the customer already has a main contact — added as a normal contact'); }
        if (primary) primarySet.add(target);
        plan.contacts.push({ cust: target, full_name: who, role: v[col('contacts', 2)].slice(0, 80) || null, mobile, email, is_primary: primary, email_as: emailAs, remarks: v[col('contacts', 7)].slice(0, 500) || null });
        rows.push({ row, name: `${who} (${cname})`, status: 'new', note: [emailAs ? `on emails: ${emailAs === 'none' ? 'not by default' : emailAs.toUpperCase()}` : '', primary ? 'main contact' : '', ...note].filter(Boolean).join('; ') });
      } catch (e: any) { rows.push({ row, name: `${who || '(no name)'} (${cname || '?'})`, status: 'problem', note: e.message }); }
    }
    sheets.push({ name: SHEETS.contacts, rows });
  }

  // ---- vendors
  if (data.vendors.length) {
    const rows: RowResult[] = [];
    for (const { row, v } of data.vendors) {
      const name = v[col('vendors', 0)];
      try {
        if (!canVend) throw bad('You cannot add vendors');
        const typeRaw = lc(v[col('vendors', 1)]);
        const type = VENDOR_TYPES.find((o) => o.value === typeRaw || lc(o.label) === typeRaw)?.value;
        if (!typeRaw) throw bad('Type is required');
        if (!type) throw bad(`Type "${v[col('vendors', 1)]}" is not in the list (${VENDOR_TYPES.map((o) => o.label).join(', ')})`);
        const vals: Record<string, any> = { vendor_type: type };
        for (const [i, k] of [[0, 'name'], [2, 'trn'], [3, 'contact_person'], [4, 'contact_number'], [5, 'email'], [6, 'address'], [7, 'remarks']] as [number, string][])
          vals[k] = parseField(field(vendDef, k), v[col('vendors', i)]);
        const k = String(name).trim().toUpperCase();
        if (fileVend.has(k)) throw bad('This vendor is listed twice in the file');
        fileVend.set(k, true);
        const ex = vByName.get(k);
        if (ex) {
          const fill: Record<string, any> = {};
          for (const f of Object.keys(vals)) if (!['name', 'vendor_type'].includes(f) && vals[f] !== null && (ex[f] === null || ex[f] === '')) fill[f] = vals[f];
          if (Object.keys(fill).length) plan.fillVend.push({ id: ex.id, ...fill });
          rows.push({ row, name: ex.name, status: 'exists', note: Object.keys(fill).length ? `Already in RFS CRM — fills ${Object.keys(fill).map((f) => field(vendDef, f).label.toLowerCase()).join(', ')}` : 'Already in RFS CRM — nothing to change' });
        } else {
          plan.newVend.push({ ...vals, is_active: true });
          rows.push({ row, name, status: 'new', note: VENDOR_TYPES.find((o) => o.value === type)!.label });
        }
      } catch (e: any) { rows.push({ row, name: name || '(no name)', status: 'problem', note: e.message }); }
    }
    sheets.push({ name: SHEETS.vendors, rows });
  }

  // ---- vendor coverage
  if (data.coverage.length) {
    const rows: RowResult[] = [];
    const seen = new Set<string>();
    for (const { row, v } of data.coverage) {
      const vname = v[col('coverage', 0)], where = v[col('coverage', 2)];
      try {
        if (!canManageCoverage(actor)) throw bad('Only the Super Admin, the Commercials Manager or whoever manages vendors sets coverage');
        const vk = String(vname).trim().toUpperCase();
        if (!vk) throw bad('Vendor name is required');
        const vendor = vByName.get(vk)?.id ?? (fileVend.has(vk) && plan.newVend.some((x) => String(x.name).trim().toUpperCase() === vk) ? `newv:${vk}` : null);
        if (!vendor) throw bad(`"${vname}" is not in the Vendors sheet or in RFS CRM`);
        const scopeRaw = lc(v[col('coverage', 1)]);
        const scope = scopeRaw.startsWith('port') ? 'port' : scopeRaw.startsWith('country') ? 'country' : scopeRaw.startsWith('region') ? 'region' : null;
        if (!scope) throw bad('Covers: Port, Country or Region');
        if (!where) throw bad('Where is required');
        let port: string | null = null, country: string | null = null, region: string | null = null;
        if (scope === 'port') {
          const p = (await q(`select code, name from ports where code = upper($1) or (lower(name) = $2 and weight >= 1) order by (code = upper($1)) desc, weight desc limit 1`, [where.trim(), lc(where)]))[0];
          if (!p) throw bad(`Port "${where}" not found — use the port code (e.g. DEHAM)`); port = p.code;
        } else if (scope === 'country') {
          const c = countries.find((x) => x.code === where.trim().toUpperCase() || x.name === lc(where) || x.name.replace(/,.*$/, '') === lc(where));
          if (!c) throw bad(`Country "${where}" not found`); country = c.code;
        } else {
          const r = regions.find((x) => x.name === lc(where));
          if (!r) throw bad(`Region "${where}" not found — see Commercials → Ports & regions`); region = r.id;
        }
        const modes = v[col('coverage', 3)].split(/[,;/]+/).map((x) => lc(x)).filter(Boolean).map((m) => { const c = MODE_WORDS[m]; if (!c) throw bad(`Mode "${m}" — use FCL, LCL, Air, Road or Courier`); return c; });
        const sideRaw = lc(v[col('coverage', 4)]);
        const side = !sideRaw || sideRaw === 'both' ? 'both' : sideRaw.startsWith('orig') ? 'origin' : sideRaw.startsWith('dest') ? 'destination' : (() => { throw bad('Side: Origin, Destination or Both'); })();
        const priRaw = lc(v[col('coverage', 5)]);
        const priority = !priRaw || priRaw.startsWith('norm') ? 2 : priRaw.startsWith('pref') ? 1 : priRaw.startsWith('back') ? 3 : (() => { throw bad('Priority: Preferred, Normal or Backup'); })();
        const dk = `${vendor}|${scope}|${port ?? country ?? region}`;
        if (seen.has(dk)) throw bad('This coverage is listed twice in the file');
        seen.add(dk);
        if (coverage.some((c) => c.vendor_id === vendor && c.scope === scope && (c.port_code ?? c.country_code ?? c.region_id) === (port ?? country ?? region)))
          { rows.push({ row, name: `${vname}: ${where}`, status: 'exists', note: 'Already in this agent\'s coverage — skipped' }); continue; }
        plan.coverage.push({ vendor, scope, port, country, region, modes, side, priority, note: v[col('coverage', 6)].slice(0, 200) || null });
        rows.push({ row, name: `${vname}: ${where}`, status: 'new', note: `${scope}${modes.length ? ` · ${modes.join(', ')}` : ''}${side !== 'both' ? ` · ${side}` : ''}${priority === 1 ? ' · preferred' : priority === 3 ? ' · backup' : ''}` });
      } catch (e: any) { rows.push({ row, name: `${vname || '?'}: ${where || '?'}`, status: 'problem', note: e.message }); }
    }
    sheets.push({ name: SHEETS.coverage, rows });
  }

  const count = (s: RowResult['status']) => sheets.reduce((n, sh) => n + sh.rows.filter((r) => r.status === s).length, 0);
  const summary = { new: count('new'), exists: count('exists'), problems: count('problem') };
  if (!apply) return { checked: true, sheets, summary };

  // ---------------------------------------------------------------- import: everything good in one transaction
  await tx(async (c) => {
    const ids = new Map<string, string>();
    if (plan.newCust.length) {
      const ks = ['name', 'code', 'trn', 'email', 'contact_person', 'contact_number', 'address', 'service_instructions', 'remarks'];
      const r = await c.query(`insert into customers (${ks.join(', ')}, is_active) select ${ks.join(', ')}, true from unnest(${ks.map((_, i) => `$${i + 1}::text[]`).join(', ')}) as t(${ks.join(', ')})
        returning id, lower(name) n`, ks.map((k) => plan.newCust.map((x) => x[k] ?? null)));
      for (const x of r.rows) ids.set(`newc:${x.n}`, x.id);
    }
    for (const f of plan.fillCust) {
      const ks = Object.keys(f).filter((k) => k !== 'id');
      await c.query(`update customers set ${ks.map((k, i) => `${k} = coalesce(nullif(${k}, ''), $${i + 2})`).join(', ')} where id = $1`, [f.id, ...ks.map((k) => f[k])]);
    }
    const idOf = (k: string) => ids.get(k) ?? k;
    if (plan.owners.length)
      await c.query(`insert into customer_salesmen (customer_id, user_id, is_main, created_by) select * , $4::uuid from unnest($1::uuid[], $2::uuid[], $3::bool[]) on conflict do nothing`,
        [plan.owners.map((o) => idOf(o.cust)), plan.owners.map((o) => o.user), plan.owners.map((o) => o.main), actor.id]);
    if (plan.contacts.length) {
      const ks = ['full_name', 'role', 'mobile', 'email', 'email_as', 'remarks'];
      await c.query(`insert into customer_contacts (customer_id, is_primary, ${ks.join(', ')}) select * from unnest($1::uuid[], $2::bool[], ${ks.map((_, i) => `$${i + 3}::text[]`).join(', ')})`,
        [plan.contacts.map((x) => idOf(x.cust)), plan.contacts.map((x) => x.is_primary), ...ks.map((k) => plan.contacts.map((x) => x[k] ?? null))]);
    }
    if (plan.newVend.length) {
      const ks = ['name', 'vendor_type', 'trn', 'contact_person', 'contact_number', 'email', 'address', 'remarks'];
      const r = await c.query(`insert into vendors (${ks.join(', ')}, is_active) select ${ks.join(', ')}, true from unnest(${ks.map((_, i) => `$${i + 1}::text[]`).join(', ')}) as t(${ks.join(', ')})
        returning id, upper(btrim(name)) n`, ks.map((k) => plan.newVend.map((x) => x[k] ?? null)));
      for (const x of r.rows) ids.set(`newv:${x.n}`, x.id);
    }
    for (const f of plan.fillVend) {
      const ks = Object.keys(f).filter((k) => k !== 'id');
      await c.query(`update vendors set ${ks.map((k, i) => `${k} = coalesce(nullif(${k}, ''), $${i + 2})`).join(', ')} where id = $1`, [f.id, ...ks.map((k) => f[k])]);
    }
    for (const x of plan.coverage)
      await c.query(`insert into agent_coverage (vendor_id, scope, port_code, country_code, region_id, modes, side, priority, note, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [idOf(x.vendor), x.scope, x.port, x.country, x.region, x.modes, x.side, x.priority, x.note, actor.id]);
    await audit(c, actor, { entity_type: 'setting', entity_id: null, action: 'Bulk upload', sensitivity: 'admin',
      new_value: `customers +${plan.newCust.length} (filled ${plan.fillCust.length}), contacts +${plan.contacts.length}, salesmen +${plan.owners.length}, vendors +${plan.newVend.length} (filled ${plan.fillVend.length}), coverage +${plan.coverage.length}; ${summary.problems} row(s) with problems skipped` });
  });
  return { imported: true, sheets, summary };
}
