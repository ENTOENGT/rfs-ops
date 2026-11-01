/** Migration 013 — quotations (confidential rates, approval, accept → Job File), new roles, money-screens switch. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { q, one } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createMaster } from '../src/server/masters';
import { updateUser, lookups } from '../src/server/admin';
import * as qt from '../src/server/quotations';
import { getJobFile } from '../src/server/jobfiles';
import { saveSettings } from '../src/server/workflow';
import { financials } from '../src/server/financials';
import { reportList, runReport } from '../src/server/reports';
import { listNotifications } from '../src/server/admin';
import { listContacts, saveContact } from '../src/server/contacts';

let admin: Actor, sales: Actor, mgr: Actor, opsSub: Actor, transport: Actor, cs: Actor, wh: Actor, pro: Actor, customer: string;
const D = (n: number) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
async function rejects(p: Promise<unknown>, code: string, msg?: RegExp) {
  await assert.rejects(p, (e: any) => { assert.equal(e.code, code, e.message); if (msg) assert.match(e.message, msg); return true; });
}
const SELL = '7777.77';
const quote = (extra: any = {}) => ({ customer_id: customer, service_type: 'sea_fcl', direction: 'import', origin: 'Shanghai', destination: 'Jebel Ali',
  lines: [
    { description: 'Ocean freight', charge_unit: 'container', quantity: '2', cost_rate: '1000', sell_rate: '1200' },
    { description: 'THC destination', charge_unit: 'container', quantity: '2', cost_rate: '350.50', sell_rate: '400' },
    { description: 'Documentation', charge_unit: 'shipment', quantity: '1', cost_rate: '0', sell_rate: '150' },
  ], ...extra });

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  sales = await mkUser(admin, 'Sally', 'sales');
  mgr = await mkUser(admin, 'ComMgr', 'operations_manager', 'commercial');
  opsSub = await mkUser(admin, 'Sub', 'operations', 'commercial');
  transport = await mkUser(admin, 'Trans', 'transport_manager');
  cs = await mkUser(admin, 'CS', 'customer_service');
  wh = await mkUser(admin, 'WH', 'warehouse_manager');
  pro = await mkUser(admin, 'Officer', 'pro_officer');
  customer = (await createMaster(mgr, 'customers', { name: 'Desert Retail' })).id;
});

test('New roles exist with the right sides; quotations can never reach Transport, PRO or Warehouse people', async () => {
  const roles = (await q(`select code, side from roles where code in ('sales','customer_service','freight_ops','dispatcher','warehouse_manager','warehouse_operator','erp_admin') order by code`));
  assert.equal(roles.length, 7);
  assert.equal(roles.find((r) => r.code === 'warehouse_operator')!.side, 'warehouse');
  for (const a of [transport, wh, pro]) {
    await updateUser(admin, a.id, { overrides: [{ code: 'quotes.view', granted: true }, { code: 'finance.selling.view', granted: true }] });
    const again = (await loadActor(a.id))!;
    assert.equal(again.has('quotes.view'), false, `${a.full_name}: refused by the database rule`);
    await rejects(qt.listQuotations(again, {}), 'FORBIDDEN');
    await updateUser(admin, a.id, { overrides: [] });
  }
  await rejects(qt.listQuotations(cs, {}), 'FORBIDDEN');   // customer service follows shipments, not prices
});

let qid: string;
test('Sales builds a quotation; totals are exact; margin below the minimum needs approval', async () => {
  await rejects(qt.createQuotation(sales, { customer_id: customer, lines: [] }), 'VALIDATION');
  await rejects(qt.createQuotation(sales, quote({ lines: [] })), 'VALIDATION', /at least one/);
  await rejects(qt.createQuotation(sales, quote({ lines: [{ description: 'x', charge_unit: 'kg', quantity: '0', sell_rate: '1' }] })), 'VALIDATION', /quantity/);
  await rejects(qt.createQuotation(sales, quote({ valid_until: D(-1) })), 'VALIDATION', /passed/);
  const x = await qt.createQuotation(sales, quote());
  qid = x.id;
  assert.match(x.quote_no, /^Q-\d+$/);
  let g = await qt.getQuotation(sales, qid);
  assert.equal(g.valid_until, D(14), 'default validity from Settings');
  assert.deepEqual(g.totals, { cost_total: '2701.00', sell_total: '3350.00', margin: '649.00', margin_pct: '19.37' });
  // 19.37% is above the 10% minimum → approved straight away
  g = await qt.quotationAction(sales, qid, { action: 'submit' });
  assert.equal(g.status, 'approved');
  // a change after approval sends it back to draft
  g = await qt.updateQuotation(sales, qid, { lines: [...quote().lines.slice(0, 2).map((l: any) => ({ ...l, sell_rate: l.cost_rate }))] });
  assert.equal(g.status, 'draft');
  assert.equal(g.totals.margin_pct, '0.00');
  g = await qt.quotationAction(sales, qid, { action: 'submit' });
  assert.equal(g.status, 'pending_approval');
  assert.ok((await listNotifications(mgr)).rows.some((n: any) => n.title === `Quotation ${g.quote_no} needs approval`));
  await rejects(qt.quotationAction(sales, qid, { action: 'approve' }), 'FORBIDDEN');
  await rejects(qt.quotationAction(mgr, qid, { action: 'reject_approval' }), 'VALIDATION', /why/);
  g = await qt.quotationAction(mgr, qid, { action: 'reject_approval', reason: 'Margin too thin' });
  assert.equal(g.status, 'draft'); assert.equal(g.decline_reason, 'Margin too thin');
  g = await qt.updateQuotation(sales, qid, { lines: quote().lines });
  g = await qt.quotationAction(sales, qid, { action: 'submit' });
  assert.equal(g.status, 'approved');
});

test('Someone without cost view sees no cost or margin — and can edit lines without wiping the cost', async () => {
  await updateUser(admin, opsSub.id, { overrides: [{ code: 'quotes.view', granted: true }, { code: 'quotes.create', granted: true },
    { code: 'finance.selling.view', granted: true }, { code: 'finance.buying.view', granted: false }] });
  const s = (await loadActor(opsSub.id))!;
  const g = await qt.getQuotation(s, qid);
  const json = JSON.stringify(g);
  assert.ok(!json.includes('cost_rate') && !json.includes('cost_total') && !json.includes('"margin_pct"') && !json.includes('"margin"') && !json.includes('2701'), 'no cost anywhere');
  assert.equal(g.totals.sell_total, '3350.00');
  await qt.updateQuotation(s, qid, { lines: g.lines.map((l: any) => ({ ...l, sell_rate: l.sell_rate, cost_rate: '0' })) });
  const full = await qt.getQuotation(sales, qid);
  assert.equal(full.totals.cost_total, '2701.00', 'cost rates kept');
  await updateUser(admin, opsSub.id, { overrides: [] });
  await qt.quotationAction(sales, qid, { action: 'submit' });
});

test('Accepted quotation becomes a Job File with a typed Job No.; the quotation is then locked', async () => {
  let g = await qt.quotationAction(sales, qid, { action: 'send', note: 'Emailed to buyer' });
  assert.equal(g.status, 'sent');
  await rejects(qt.quotationAction(sales, qid, { action: 'accept' }), 'VALIDATION', /Job No/);
  g = await qt.quotationAction(sales, qid, { action: 'accept', job_no: 'Q-JOB-1' });
  assert.equal(g.status, 'accepted');
  assert.equal(g.job_no, 'Q-JOB-1');
  const f = await getJobFile(sales, g.job_file_id);
  assert.equal(f.mode, 'sea_fcl'); assert.equal(f.origin, 'Shanghai'); assert.equal(f.quotation.quote_no, g.quote_no);
  assert.ok(!JSON.stringify(f).includes('1200'), 'the Job File carries no rates');
  // transport can see the Job File, but not which quotation or any price
  const ft = await getJobFile(transport, g.job_file_id);
  assert.equal(ft.quotation, null); assert.equal(ft.quotation_id, undefined);
  await rejects(qt.updateQuotation(sales, qid, { scope: 'x' }), 'QUOTE_LOCKED');
  await rejects(qt.quotationAction(sales, qid, { action: 'cancel', reason: 'x' }), 'QUOTE_STATE');
});

test('Expired quotations cannot be sent or accepted; a copy starts a fresh draft', async () => {
  const x = await qt.createQuotation(sales, quote());
  await qt.quotationAction(sales, x.id, { action: 'submit' });
  await q('update quotations set valid_until = $2 where id = $1', [x.id, D(-1)]);
  const g = await qt.getQuotation(sales, x.id);
  assert.equal(g.status, 'expired'); assert.equal(g.can.accept, false);
  await rejects(qt.quotationAction(sales, x.id, { action: 'accept', job_no: 'NOPE' }), 'QUOTE_EXPIRED');
  assert.ok((await qt.listQuotations(sales, { status: 'expired' })).rows.some((r: any) => r.id === x.id));
  const c = await qt.copyQuotation(sales, x.id);
  const cg = await qt.getQuotation(sales, c.id);
  assert.equal(cg.status, 'draft'); assert.equal(cg.totals.sell_total, '3350.00'); assert.ok(cg.valid_until >= D(0));
});

test('Customer contacts: several per customer, one primary, edits need customer rights', async () => {
  await rejects(saveContact(transport, customer, { full_name: 'X', mobile: '0501112233' }), 'FORBIDDEN');
  await rejects(saveContact(mgr, customer, { full_name: 'No way to reach' }), 'VALIDATION', /mobile number or an email/);
  await saveContact(mgr, customer, { full_name: 'Aisha', role: 'Operations', mobile: '050 111 2233', is_primary: true });
  const r = await saveContact(mgr, customer, { full_name: 'Ravi', role: 'Accounts', email: 'ravi@desert.ae', is_primary: true });
  assert.deepEqual(r.contacts.map((c: any) => [c.full_name, c.is_primary]), [['Ravi', true], ['Aisha', false]]);
  const seen = await listContacts(transport, customer);
  assert.equal(seen.contacts.length, 2); assert.equal(seen.can_edit, false);
});

test('Money screens switch: off hides the Financials page and money columns; on brings them back; nothing is deleted', async () => {
  const P = { from: D(-30), to: D(30) };
  assert.ok((await reportList(mgr)).some((r) => r.key === 'financial'));
  await rejects(saveSettings(mgr, { money_screens: false }), 'FORBIDDEN');
  await saveSettings(admin, { money_screens: false });
  assert.equal((await lookups(mgr) as any).money_screens, false);
  await rejects(financials(mgr, P), 'MONEY_SCREENS_OFF');
  const fr = await runReport(mgr, 'financial', P);
  assert.ok(!fr.columns.some((c) => ['net_revenue', 'vat', 'gross_profit', 'margin_pct'].includes(c.key)), 'only cost columns remain');
  // quotations are operational/commercial records, not accounting: they stay available
  assert.ok((await qt.listQuotations(mgr, {})).total >= 2);
  await saveSettings(admin, { money_screens: true });
  assert.ok((await runReport(mgr, 'financial', P)).columns.some((c) => c.key === 'net_revenue'));
  assert.equal((await one(`select value from settings where key = 'money_screens'`)).value, true);
});
