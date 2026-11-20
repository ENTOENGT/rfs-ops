/** 20 Nov fix: "Create enquiry" also reads the email's attachments — Excel / CSV / Word as text, PDF / pictures sent to
 *  Claude as they are; old .xls and too-big files are named in a note; a draft made before this is read again once. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { resetDb, mkUser } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import * as ol from '../src/server/outlook';
import { setAiNetwork } from '../src/server/ai';
import { draftEnquiry } from '../src/server/newenquiry';

let admin: Actor, cora: Actor, rowId: string;
let sent: any = null;
let sheetB64 = '';

before(async () => {
  await resetDb();
  Object.assign(process.env, { MS_TENANT_ID: 't', MS_CLIENT_ID: 'c', MS_CLIENT_SECRET: 's', ANTHROPIC_API_KEY: 'fake-key-for-tests-only-0123456789' });
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  await ol.setPilot(admin, cora.id, true);
  await q(`insert into outlook_connections (user_id, ms_user_id, ms_email, refresh_token_enc, access_token_enc, access_expires_at, scope)
    values ($1, 'ms', 'coracoord@x.ae', $2, $3, now() + interval '1 hour', $4)`, [cora.id, ol.seal('r'), ol.seal('a'), ol.SCOPES]);
  // the customer's costing sheet
  const wb = new ExcelJS.Workbook();
  const first = wb.addWorksheet('Discovery Questions');
  first.addRow(['DISCOVERY QUESTIONS']); first.addRow(['A long instruction in merged cells', '', '', '', '', '']); first.mergeCells('A2:F2');
  for (let i = 0; i < 400; i++) first.addRow([i, `Question ${i}`, 'example', 'answer']);
  const ws = wb.addWorksheet('Costing');
  ws.addRow(['Field', 'Value']); ws.addRow(['Mode', 'Sea FCL']); ws.addRow(['Container', '1x40HC']); ws.addRow(['POL', 'Shanghai']);
  ws.addRow(['POD', 'Jebel Ali']); ws.addRow(['Incoterm', 'FOB']); ws.addRow(['Commodity', 'Furniture']); ws.addRow(['Weight (kg)', 8000]);
  sheetB64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
  await q(`update enquiry_checks set is_active = true where label ~* '(stack|insur)'`);          // switched on, as in your checklist
  rowId = (await one(`insert into outlook_inbox (user_id, ms_message_id, internet_message_id, from_addr, from_name, subject, received_at, body_excerpt, has_attachments, status, ai_kind, ai_checked_at,
      ai_draft) values ($1, 'MSG1', '<m1@x>', 'jrrrahman@gmail.com', 'Mohamed Rahman', 'New enquiry', now(), 'Please find the attached sheet, kindly provide the best rate.', true, 'unmatched', 'new_enquiry', now(),
      '{"mode": "sea_fcl", "summary": "old draft without attachments"}') returning id`, [cora.id]))!.id;
  ol.setNetwork((async (url: any) => {
    const u = decodeURIComponent(String(url));
    const json = (j: any) => new Response(JSON.stringify(j), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (u.includes('/me/messages/MSG1?$select=body')) return json({ body: { content: 'Dear Shamsheer,\nPlease find the attached Sheet, kindly check and provide the best rate.\nThanks' } });
    if (u.endsWith('/attachments?$select=id,name,contentType,size,isInline')) return json({ value: [
      { '@odata.type': '#microsoft.graph.fileAttachment', id: 'A1', name: 'RedChief_Costing_Sheet.xlsx', contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', size: 9000, isInline: false },
      { '@odata.type': '#microsoft.graph.fileAttachment', id: 'A2', name: 'packing.pdf', contentType: 'application/pdf', size: 2000, isInline: false },
      { '@odata.type': '#microsoft.graph.fileAttachment', id: 'A3', name: 'old.xls', contentType: 'application/vnd.ms-excel', size: 2000, isInline: false },
      { '@odata.type': '#microsoft.graph.fileAttachment', id: 'A4', name: 'huge.pdf', contentType: 'application/pdf', size: 9_000_000, isInline: false },
      { '@odata.type': '#microsoft.graph.fileAttachment', id: 'A5', name: 'logo.png', contentType: 'image/png', size: 900, isInline: true },
    ] });
    if (u.endsWith('/attachments/A1')) return json({ contentBytes: sheetB64 });
    if (u.endsWith('/attachments/A2')) return json({ contentBytes: Buffer.from('%PDF-1.4 fake').toString('base64') });
    return new Response('{}', { status: 404 });
  }) as typeof fetch);
  setAiNetwork((async (_u: any, init: any) => {
    sent = JSON.parse(init.body);
    return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'enquiry_from_email', input: { mode: 'sea_fcl', incoterm: 'FOB', origin_country: 'China', origin_port: 'Shanghai',
      destination_port: 'Jebel Ali', cargo_description: 'Furniture', containers: '1x40HC', gross_weight_kg: 8000, hazardous: 'no', stackable: 'yes', insurance: 'yes',
      cargo_value: 195635.14, cargo_value_currency: 'aed', summary: '1x40HC Shanghai to Jebel Ali' } }] }), { status: 200 });
  }) as typeof fetch);
});

test('the attached sheet is read as text, the PDF goes to the AI as it is; old .xls / too big / logo are not read', async () => {
  const r: any = await draftEnquiry(cora, rowId);
  const content = sent.messages[0].content;
  assert.ok(Array.isArray(content), 'text and the PDF together');
  assert.equal(content[0].type, 'document'); assert.equal(content[0].source.media_type, 'application/pdf');
  const text = content.at(-1).text;
  assert.match(text, /\[Attachment: RedChief_Costing_Sheet\.xlsx\]/);
  assert.match(text, /POL \| Shanghai/); assert.match(text, /Weight \(kg\) \| 8000/);
  assert.equal(text.match(/A long instruction in merged cells/g)!.length, 1, 'merged cells: the text once, not once per cell');
  assert.ok(text.indexOf('[Sheet: Costing]') > 0, 'the second tab is still read after a long first tab');
  assert.match(text, /kindly check and provide the best rate/);
  const d = r.draft;
  assert.deepEqual(d.attachments_read, ['RedChief_Costing_Sheet.xlsx', 'packing.pdf']);
  assert.ok(d.attachments_notes.some((n: string) => /old\.xls.*\.xlsx/.test(n)));
  assert.ok(d.attachments_notes.some((n: string) => /huge\.pdf.*too big/.test(n)));
  assert.ok(!JSON.stringify(d.attachments_notes).includes('logo.png'), 'pictures inside the signature are skipped');
  assert.deepEqual([d.mode, d.incoterm, d.origin_country, d.pol_code, d.pod_code, d.gross_weight_kg], ['sea_fcl', 'FOB', 'CN', 'CNSGH', 'AEJEA', 8000]);
  assert.equal(d.summary, '1x40HC Shanghai to Jebel Ali', 'the old draft (made without the attachment) was read again');
  assert.deepEqual([d.cargo_value, d.cargo_value_currency], [195635.14, 'AED']);
  const labels = await q(`select id, label from enquiry_checks`);
  const ans = (re: RegExp) => d.enquiry_details?.[labels.find((l: any) => re.test(l.label))?.id];
  assert.deepEqual([ans(/hazard/i), ans(/stack/i), ans(/insur/i)], ['no', 'yes', 'yes']);
});

test('read once: the next time it comes from what was kept', async () => {
  sent = null;
  await draftEnquiry(cora, rowId);
  assert.equal(sent, null);
});
