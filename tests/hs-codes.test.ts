/** Migration 036: the HS code list from Dubai Customs' Tariff Report — loading it (leading zeros put back, active line wins,
 *  a second load adds nothing twice), checking codes (heading / 8 / 12 digits, prohibited, not in our record), permissions. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { resetDb, mkUser } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { checkHs, importTariff, pad } from '../src/server/hscodes';

let admin: Actor, sam: Actor, file = '';
const HEAD = ['HSCode', 'Short Desc', 'Duty %', 'Original Duty %', 'Service Charge %', 'Status', 'Effective From', 'Effective To', 'Is Vehicle', 'Group', 'Last Updated On'];
const PRH = ['PR S.No', 'HSCode', 'HSCode Desc', 'Action Type', 'Fully Prohibited', 'Controling Authority', 'Remarks', 'Start Date', 'End Date', 'status', 'Action Indicator'];

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  sam = await mkUser(admin, 'Sam Sales', 'sales');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('HSCode');
  ws.getRow(1).values = ['Dubai Customs']; ws.getRow(2).values = ['List of All HSCodes as on 03rd February 2022']; ws.getRow(4).values = HEAD;
  const rows = [
    [1011010, 'Pure-bred horses', 5, 5, 0, 'In Active'], [1011010, 'Pure-bred horses', 0, 0, 0, 'Active'],    // the active line wins
    [1031000, 'Pure-bred swine', 0, 0, 0, 'Active'],
    [64041100, 'Sports footwear', 5, 5, 0, 'Active'], [64041900, 'Other footwear', 5, 5, 0, 'Active'], [64042000, 'Leather soles', 10, 10, 0, 'In Active'],
    [93020000, 'Revolvers and pistols', 5, 5, 0, 'Active'],
  ];
  rows.forEach((r, i) => { ws.getRow(5 + i).values = [...r, new Date('2020-01-01'), null, 'N', 'G1', new Date('2021-05-01')]; });
  const pr = wb.addWorksheet('PR');
  pr.getRow(1).values = ['Prohibited / Restricted']; pr.getRow(3).values = PRH;
  pr.getRow(4).values = [1, 93020000, 'Revolvers', 'P', 'N', 'Ministry of Interior', 'Permit needed', new Date('2015-01-01'), null, 'A', 'I'];
  pr.getRow(5).values = [2, 1031000, 'Swine', 'P', 'Y', 'MOCCAE', 'Banned', new Date('2015-01-01'), null, 'A', 'I'];
  pr.getRow(6).values = [3, 64041100, 'Footwear', 'R', 'N', 'Old rule', null, new Date('2010-01-01'), new Date('2012-01-01'), 'A', 'I'];   // ended
  file = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
});

test('leading zeros come back', () => {
  assert.equal(pad(1011010), '01011010'); assert.equal(pad('6404.11.00'), '64041100'); assert.equal(pad('103'), '0103');
});

test('before loading: says so', async () => {
  const r = await checkHs('6404');
  assert.equal(r.loaded, false); assert.equal(r.results[0].message, 'The HS code list is not loaded yet');
});

test('only the Super Admin / Commercials Manager loads it', async () => {
  await assert.rejects(importTariff(sam, { file, name: 't.xlsx' }), /Only the Super Admin/);
});

test('load: codes, the active line, the PR list, the "as on" date; loading again adds nothing twice', async () => {
  const r = await importTariff(admin, { file, name: 'Tariff_Report.xlsx' });
  assert.deepEqual([r.info.codes, r.info.active, r.info.controls, r.info.as_of], [6, 5, 3, '03rd February 2022']);
  await importTariff(admin, { file, name: 'Tariff_Report.xlsx' });
  assert.equal(Number((await one('select count(*) n from hs_tariff')).n), 6);
  assert.equal(Number((await one('select count(*) n from hs_controls')).n), 3);
  assert.deepEqual(await one(`select status, duty_pct::float d from hs_tariff where code = '01011010'`), { status: 'Active', d: 0 });
  assert.ok(await one(`select 1 from audit_log where action = 'HS code list loaded'`));
});

test('check: heading, 8 digits, 12 digits, in active, prohibited, not in our record, not a code; each once', async () => {
  const r = await checkHs('6404, 6404.11.00, 640411000000, 64042000, 9302.00.00, 0103, 99999999, 12, 6404');
  const m = Object.fromEntries(r.results.map((x) => [x.input, x.message]));
  assert.equal(r.results.length, 8, 'the second 6404 is left out');
  assert.equal(m['6404'], '3 codes under 6404 · duty 5%');
  assert.equal(m['6404.11.00'], 'Duty 5%', 'the ended restriction is not shown');
  assert.equal(m['640411000000'], 'Duty 5% (checked as 64041100)');
  assert.equal(m['64042000'], 'In Active — not an active code');
  assert.equal(m['9302.00.00'], 'Duty 5% · PROHIBITED');
  assert.equal(r.results.find((x) => x.input === '9302.00.00')!.controls[0].authority, 'Ministry of Interior');
  assert.equal(m['0103'], '1 code under 0103 · duty 0% · PROHIBITED');
  assert.equal(m['99999999'], 'Not in our record');
  assert.equal(m['12'], 'Not an HS code (4 to 12 digits)');
});

test('a file without the HS code tab is refused, and nothing changes', async () => {
  const wb = new ExcelJS.Workbook(); wb.addWorksheet('Sheet1').addRow(['hello']);
  await assert.rejects(importTariff(admin, { file: Buffer.from(await wb.xlsx.writeBuffer()).toString('base64') }), /No HS code tab/);
  await assert.rejects(importTariff(admin, { file: Buffer.from('not excel').toString('base64') }), /not an Excel file/);
  assert.equal(Number((await one('select count(*) n from hs_tariff')).n), 6);
  void q;
});
