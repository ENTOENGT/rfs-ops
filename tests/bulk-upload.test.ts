/** Bulk upload of customers / contacts / vendors / coverage from the Excel template: check first, import, never a duplicate. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { resetDb, mkUser } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { template, bulkUpload } from '../src/server/bulkimport';

let admin: Actor, cm: Actor, sam: Actor, sara: Actor, existing: string;

async function fileFrom(rows: Record<string, (string | null)[][]>) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await template(cm) as any);
  for (const [sheet, list] of Object.entries(rows)) { const ws = wb.getWorksheet(sheet)!; list.forEach((r, i) => { ws.getRow(i + 2).values = r as any; }); }
  return Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
}
const row = (res: any, sheet: string, name: string) => res.sheets.find((s: any) => s.name === sheet).rows.find((r: any) => r.name.startsWith(name));

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  cm = await mkUser(admin, 'Carl Commercial', 'commercials_manager');
  const cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
  sara = await mkUser(admin, 'Sara Sales', 'sales', undefined, { coordinator_id: cora.id });
  existing = (await createMaster(cm, 'customers', { name: 'Desert Retail', email: 'info@desert.ae' })).id;
  await createMaster(cm, 'vendors', { name: 'MSC', vendor_type: 'shipping_line', email: 'rates@msc.example' });
});

let file = '';
test('the template has the four sheets, the Read me and the salesmen list', async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await template(cm) as any);
  assert.deepEqual(wb.worksheets.map((w) => w.name), ['Read me', 'Lists', 'Customers', 'Customer contacts', 'Vendors', 'Vendor coverage', 'Vendor teams']);
  const lists = wb.getWorksheet('Lists')!;
  assert.ok([2, 3, 4].map((r) => lists.getCell(r, 1).value).includes('samsales@x.ae'));
  await assert.rejects(template(await mkUser(admin, 'Mo Messenger', 'messenger', 'messengers', { mobile: '0501112233' })), (e: any) => e.code === 'FORBIDDEN');
});

test('check: row by row, nothing saved', async () => {
  file = await fileFrom({
    Customers: [
      ['Eta Trading', 'ETA01', '100200300400003', 'samsales@x.ae', 'Sara Sales', 'info@eta.ae', 'Nina', '+971 4 111 2222', 'Deira, Dubai', null, null],
      ['Desert Retail', null, null, 'samsales@x.ae', null, 'other@desert.ae', 'Omar', null, 'Al Quoz', null, null],   // already there
      ['Gamma LLC', null, null, 'nobody@x.ae', null, null, null, null, null, null, null],                              // not a salesman
      ['Eta Trading', null, null, null, null, null, null, null, null, null, null],                                     // twice
      ['Bad Mail Co', null, null, null, null, 'not-an-email', null, null, null, null, null],
    ],
    'Customer contacts': [
      ['Eta Trading', 'Nina Shah', 'Logistics', '+971 50 111 2222', 'nina@eta.ae', 'Yes', 'To', null],
      ['Eta Trading', 'Ravi Shah', 'Manager', null, 'ravi@eta.ae', 'No', 'CC', null],
      ['Desert Retail', 'Old Info', null, null, 'info@desert.ae', 'No', 'Not by default', null],
      ['Nobody Ltd', 'X', null, null, 'x@nobody.ae', null, null, null],
      ['Eta Trading', 'Odd', null, null, 'odd@eta.ae', 'Maybe', null, null],
    ],
    Vendors: [
      ['Hamburg Logistics', 'Overseas agent', null, 'Hans', '+49 40 123456', 'rates@hamlog.example', null, null],
      ['msc', 'Shipping line', null, 'Desk', null, null, 'Geneva', null],                                    // already there (any case)
      ['Weird Co', 'Spaceship', null, null, null, null, null, null],
    ],
    'Vendor coverage': [
      ['Hamburg Logistics', 'Port', 'DEHAM', 'FCL, LCL', 'Origin', 'Preferred', null],
      ['Hamburg Logistics', 'Country', 'Germany', null, null, null, null],
      ['Hamburg Logistics', 'Region', 'North Europe', 'Air', 'Both', 'Backup', null],
      ['Hamburg Logistics', 'Port', 'ZZZZZ', null, null, null, null],
      ['Unknown Agent', 'Country', 'France', null, null, null, null],
    ],
    'Vendor teams': [
      ['Hamburg Logistics', 'Sea FCL team', 'FCL@hamlog.example', 'fcl2@hamlog.example, boss@hamlog.example', 'Jan', '+49 40 1', 'FCL', 'Import, Cross trade', null],
      ['Hamburg Logistics', 'Air team', 'not-an-email', null, null, null, 'Air', null, null],
      ['Hamburg Logistics', 'Odd team', 'odd@hamlog.example', null, null, null, null, 'Sideways', null],
    ],
  });
  const r: any = await bulkUpload(cm, { file }, false);
  assert.equal(r.checked, true);
  assert.equal(row(r, 'Customers', 'Eta Trading').status, 'new');
  assert.match(row(r, 'Customers', 'Eta Trading').note, /main salesman Sam Sales \+ Sara Sales/);
  const dr = row(r, 'Customers', 'Desert Retail');
  assert.equal(dr.status, 'exists'); assert.match(dr.note, /fills contact person, address; main salesman Sam Sales/);
  assert.match(r.sheets[0].rows.find((x: any) => x.row === 4).note, /not an active Salesman/);
  assert.match(r.sheets[0].rows.find((x: any) => x.row === 5).note, /listed twice/);
  assert.match(row(r, 'Customers', 'Bad Mail Co').note, /not a valid email/);
  assert.equal(row(r, 'Customer contacts', 'Old Info').status, 'new', 'the main email is not a contact yet');
  assert.match(row(r, 'Customer contacts', 'X (Nobody').note, /not in the Customers sheet/);
  assert.match(row(r, 'Customer contacts', 'Odd').note, /Yes or No/);
  assert.equal(row(r, 'Vendors', 'MSC').status, 'exists');
  assert.match(row(r, 'Vendors', 'Weird Co').note, /not in the list/);
  assert.match(row(r, 'Vendor coverage', 'Hamburg Logistics: ZZZZZ').note, /not found/);
  assert.match(row(r, 'Vendor coverage', 'Unknown Agent').note, /not in the Vendors sheet/);
  assert.match(row(r, 'Vendor teams', 'Hamburg Logistics: Air team').note, /Email/);
  assert.match(row(r, 'Vendor teams', 'Hamburg Logistics: Odd team').note, /Direction "sideways"/);
  assert.deepEqual(r.summary, { new: 9, exists: 2, problems: 10 });
  assert.equal(await one(`select 1 from customers where name = 'Eta Trading'`), null, 'nothing saved by Check');
});

test('import: the good rows are saved, with salesmen, contacts To/CC and coverage', async () => {
  const r: any = await bulkUpload(cm, { file }, true);
  assert.equal(r.imported, true);
  const eta = await one(`select id, code, trn from customers where name = 'Eta Trading'`);
  assert.equal(eta.code, 'ETA01');
  const own = await q(`select u.full_name, o.is_main from customer_salesmen o join users u on u.id = o.user_id where o.customer_id = $1 and o.removed_at is null order by o.is_main desc`, [eta.id]);
  assert.deepEqual(own.map((o) => [o.full_name, o.is_main]), [['Sam Sales', true], ['Sara Sales', false]]);
  const ks = await q(`select full_name, is_primary, email_as from customer_contacts where customer_id = $1 order by full_name`, [eta.id]);
  assert.deepEqual(ks.map((k) => [k.full_name, k.is_primary, k.email_as]), [['Nina Shah', true, 'to'], ['Ravi Shah', false, 'cc']]);
  const dr = await one(`select email, contact_person, address from customers where id = $1`, [existing]);
  assert.deepEqual(dr, { email: 'info@desert.ae', contact_person: 'Omar', address: 'Al Quoz' }, 'existing email kept, empty fields filled');
  assert.equal((await one(`select address from vendors where name = 'MSC'`)).address, 'Geneva');
  const cov = await q(`select a.scope, a.port_code, a.country_code, a.modes, a.side, a.priority from agent_coverage a join vendors v on v.id = a.vendor_id where v.name = 'Hamburg Logistics' order by a.scope`);
  assert.deepEqual(cov.map((c) => [c.scope, c.port_code ?? c.country_code ?? 'region', c.modes, c.side, c.priority]),
    [['country', 'DE', [], 'both', 2], ['port', 'DEHAM', ['sea_fcl', 'sea_lcl'], 'origin', 1], ['region', 'region', ['air'], 'both', 3]]);
  const t = await one(`select t.email, t.cc_emails, t.modes, t.directions, t.contact_person from vendor_teams t join vendors v on v.id = t.vendor_id where v.name = 'Hamburg Logistics'`);
  assert.deepEqual(t, { email: 'fcl@hamlog.example', cc_emails: 'fcl2@hamlog.example, boss@hamlog.example', modes: ['sea_fcl'], directions: ['import', 'cross_trade'], contact_person: 'Jan' });
  assert.ok(await one(`select 1 from audit_log where action = 'Bulk upload'`));
});

test('the same file again: no duplicates at all', async () => {
  const n = async () => (await one(`select (select count(*) from customers) c, (select count(*) from customer_contacts) k, (select count(*) from vendors) v,
    (select count(*) from agent_coverage) a, (select count(*) from customer_salesmen where removed_at is null) s, (select count(*) from vendor_teams) t`));
  const before = await n();
  const r: any = await bulkUpload(cm, { file }, true);
  assert.equal(r.summary.new, 0);
  assert.match(row(r, 'Vendor teams', 'Hamburg Logistics: Sea FCL team').note, /Already there — updated/);
  assert.deepEqual(await n(), before);
});

test('a Salesman uploads their own customers; they cannot give customers to others', async () => {
  const f = await fileFrom({ Customers: [['Sam Own Co', null, null, null, null, null, null, null, null, null, null], ['Sara Co', null, null, 'sarasales@x.ae', null, null, null, null, null, null, null]] });
  const r: any = await bulkUpload(sam, { file: f }, true);
  assert.equal(row(r, 'Customers', 'Sam Own Co').status, 'new');
  assert.match(row(r, 'Customers', 'Sara Co').note, /Only the Commercials Manager/);
  const own = await one(`select u.full_name from customer_salesmen o join users u on u.id = o.user_id join customers c on c.id = o.customer_id where c.name = 'Sam Own Co' and o.is_main`);
  assert.equal(own.full_name, 'Sam Sales');
  await assert.rejects(bulkUpload(sam, { file: 'bm90IGFuIGV4Y2VsIGZpbGU=' }, false), /not an Excel file/);
});
