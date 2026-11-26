/**
 * 23 Nov — the quotation as a real PDF, made by RFS CRM (no "Print → Save as PDF" by hand): the same customer copy as the
 * print page — logo, company, customer, route, cargo, the charges table (one per route option) with the total, scope,
 * exclusions, terms, payment, remarks. Selling only: built from customerCopy(), which never returns cost or margin.
 * Attached by itself when the quotation is emailed from Outlook; also "Download PDF".
 */
import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import { Actor } from './auth';
import { customerCopy } from './quotations';
import { LOGO_PNG_B64, LOGO_SIZE } from './brandLogo';
import { detailText } from '../lib/jobfileRules';

const NAVY = rgb(0.118, 0.227, 0.373), GREY = rgb(0.38, 0.42, 0.47), LINE = rgb(0.85, 0.87, 0.9), HEAD = rgb(0.95, 0.96, 0.98), BLACK = rgb(0.1, 0.1, 0.12);
const W = 595.28, H = 841.89, M = 42;
const money = (n: unknown) => Number(n ?? 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (v: unknown) => { const d = v ? new Date(String(v).slice(0, 10) + 'T00:00:00') : null; return d && !isNaN(+d) ? d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : ''; };

export async function quotationPdf(actor: Actor, id: string): Promise<{ bytes: Uint8Array; filename: string; quote_no: string }> {
  const d: any = await customerCopy(actor, id, 'pdf');
  const pdf = await PDFDocument.create();
  pdf.setTitle(`Quotation ${d.quote_no}`); pdf.setAuthor(d.company.company_name || 'Reliance Freight Systems'); pdf.setCreator('RFS CRM');
  const font = await pdf.embedFont(StandardFonts.Helvetica), bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const logo = await pdf.embedPng(Buffer.from(LOGO_PNG_B64, 'base64'));
  // the standard PDF fonts know Western characters only: anything else is written plainly instead of breaking the file
  const safe = (f: PDFFont, s: unknown) => [...String(s ?? '').replace(/→/g, 'to').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\r/g, '')]
    .map((ch) => { if (ch === '\n') return ch; try { f.encodeText(ch); return ch; } catch { return '?'; } }).join('');
  let page: PDFPage = pdf.addPage([W, H]), y = H - M, pageNo = 1;
  const footer = () => page.drawText(safe(font, `${d.quote_no} · page ${pageNo}`), { x: W - M - font.widthOfTextAtSize(`${d.quote_no} · page ${pageNo}`, 8), y: 22, size: 8, font, color: GREY });
  const newPage = () => { footer(); page = pdf.addPage([W, H]); pageNo++; y = H - M; };
  const room = (h: number) => { if (y - h < 50) newPage(); };
  const wrap = (f: PDFFont, text: unknown, size: number, width: number) => {
    const out: string[] = [];
    for (const para of safe(f, text).split('\n')) {
      let line = '';
      for (const word of para.split(/\s+/)) {
        const t = line ? `${line} ${word}` : word;
        if (f.widthOfTextAtSize(t, size) <= width) line = t;
        else { if (line) out.push(line); line = word; while (f.widthOfTextAtSize(line, size) > width && line.length > 1) { let k = line.length; while (k > 1 && f.widthOfTextAtSize(line.slice(0, k), size) > width) k--; out.push(line.slice(0, k)); line = line.slice(k); } }
      }
      out.push(line);
    }
    return out;
  };
  const text = (s: unknown, x: number, size = 9.5, f: PDFFont = font, color = BLACK) => page.drawText(safe(f, s), { x, y, size, font: f, color });
  const para = (s: unknown, x: number, width: number, size = 9.5, f: PDFFont = font, color = BLACK, lead = 1.35) => {
    for (const l of wrap(f, s, size, width)) { room(size * lead); page.drawText(l, { x, y, size, font: f, color }); y -= size * lead; }
  };

  // ---- top: logo + company
  const lw = 190, lh = lw * LOGO_SIZE.h / LOGO_SIZE.w;
  page.drawImage(logo, { x: M, y: y - lh, width: lw, height: lh });
  const c = d.company;
  let cy = y - 2;
  for (const [s, f] of [[c.company_name, bold], [c.company_address, font], [[c.company_phone, c.company_email].filter(Boolean).join(' · '), font], [c.company_trn ? `TRN ${c.company_trn}` : '', font]] as [string, PDFFont][]) {
    if (!s) continue;
    for (const l of wrap(f, s, 8.5, 220)) { page.drawText(l, { x: W - M - f.widthOfTextAtSize(l, 8.5), y: cy - 8.5, size: 8.5, font: f, color: GREY }); cy -= 11.5; }
  }
  y = Math.min(y - lh, cy) - 22;
  text('QUOTATION', M, 18, bold, NAVY); y -= 10;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 1.2, color: NAVY }); y -= 18;

  // ---- customer (left) and quotation facts (right)
  const top = y;
  text('To', M, 8, font, GREY); y -= 12;
  para(d.customer.name, M, 250, 10.5, bold);
  if (d.customer.contact) para(`Attn: ${d.customer.contact}`, M, 250, 9);
  if (d.customer.address) para(d.customer.address, M, 250, 9, font, GREY);
  if (d.customer.trn) para(`TRN ${d.customer.trn}`, M, 250, 9, font, GREY);
  const left = y; y = top;
  const facts: [string, string][] = [['Quotation no.', d.quote_no], ['Date', fmtDate(d.date)], ['Valid until', fmtDate(d.valid_until)], ...(d.enquiry_reference ? [['Your reference', d.enquiry_reference] as [string, string]] : [])];
  for (const [k, v] of facts) { text(k, W - M - 210, 9, font, GREY); text(v, W - M - 110, 9.5, bold); y -= 14; }
  y = Math.min(left, y) - 10;

  // ---- shipment
  const cargo = [d.cargo_description, d.packages && `${d.packages} packages`, d.gross_weight_kg && `${Number(d.gross_weight_kg).toLocaleString('en-US')} kg`,
    d.volume_cbm && `${Number(d.volume_cbm)} CBM`, d.chargeable_weight_kg && `chargeable ${Number(d.chargeable_weight_kg).toLocaleString('en-US')} kg`].filter(Boolean).join(' · ');
  const ship: [string, string][] = [['Service', [d.service_name, d.direction_name].filter(Boolean).join(' · ')],
    ...((d.origin || d.destination) ? [['Route', [d.origin, d.destination].filter(Boolean).join(' to ')] as [string, string]] : []), ...(cargo ? [['Cargo', cargo] as [string, string]] : [])];
  const shipH = ship.reduce((h, [, v]) => h + wrap(font, v, 9.5, W - 2 * M - 90).length * 13, 0) + 14;
  room(shipH);
  page.drawRectangle({ x: M, y: y - shipH + 8, width: W - 2 * M, height: shipH, color: HEAD });
  y -= 6;
  for (const [k, v] of ship) { text(k, M + 10, 9, font, GREY); const ls = wrap(font, v, 9.5, W - 2 * M - 90); for (const l of ls) { page.drawText(l, { x: M + 80, y, size: 9.5, font, color: BLACK }); y -= 13; } }
  y -= 18;

  // ---- charges: one table per route option, each with its total
  const cols = [{ k: 'description', w: W - 2 * M - 300, a: 'l', t: 'Description' }, { k: 'unit_name', w: 90, a: 'l', t: 'Charged' }, { k: 'quantity', w: 40, a: 'r', t: 'Qty' },
    { k: 'rate', w: 80, a: 'r', t: `Rate (${d.currency})` }, { k: 'amount', w: 90, a: 'r', t: `Amount (${d.currency})` }];
  const tables = d.options ?? [{ option_no: null, lines: d.lines, total: d.total, details: d.details }];
  // migration 044: our local charges under their own heading; "if applicable" lines after the total, not counted in it
  const withNote = (l: any) => (l.note ? `${l.description} (${l.note})` : l.description);
  const rows = (ls: any[]) => {
    for (const l of ls) {
      const cells: Record<string, string> = { description: withNote(l), unit_name: l.unit_name ?? '', quantity: String(Number(l.quantity)), rate: money(l.rate), amount: money(l.amount) };
      const desc = wrap(font, cells.description, 9.5, cols[0].w - 10);
      const h = desc.length * 12 + 8;
      if (y - h < 60) { newPage(); headRow(); }
      let x = M + 6;
      for (const col of cols) {
        if (col.k === 'description') desc.forEach((l2, i) => page.drawText(l2, { x, y: y - i * 12, size: 9.5, font, color: BLACK }));
        else { const s2 = safe(font, cells[col.k]); page.drawText(s2, { x: col.a === 'r' ? x + col.w - 12 - font.widthOfTextAtSize(s2, 9.5) : x, y, size: 9.5, font, color: BLACK }); }
        x += col.w;
      }
      y -= h; page.drawLine({ start: { x: M, y: y + 9 }, end: { x: W - M, y: y + 9 }, thickness: 0.5, color: LINE });
    }
  };
  const subHead = (t: string) => { room(24); page.drawRectangle({ x: M, y: y - 5, width: W - 2 * M, height: 17, color: HEAD }); page.drawText(safe(bold, t), { x: M + 6, y: y, size: 9, font: bold, color: NAVY }); y -= 20; };
  let headRow = () => {};
  for (const o of tables) {
    if (o.option_no) { room(40); text(`Option ${o.option_no}: ${[o.pol, o.pod].filter(Boolean).join(' to ')}${o.label ? ` — ${o.label}` : ''}${o.selected ? ' (chosen)' : ''}`, M, 10.5, bold, NAVY); y -= 16; }
    if (o.details) { const dt = detailText(o.details); if (dt) { para(dt, M, W - 2 * M, 9, font, GREY); y -= 4; } }
    headRow = () => { room(22); page.drawRectangle({ x: M, y: y - 6, width: W - 2 * M, height: 20, color: NAVY });
      let x = M + 6; for (const col of cols) { const s2 = col.t; page.drawText(s2, { x: col.a === 'r' ? x + col.w - 12 - bold.widthOfTextAtSize(s2, 8.5) : x, y: y, size: 8.5, font: bold, color: rgb(1, 1, 1) }); x += col.w; } y -= 22; };
    headRow();
    const main = o.lines.filter((l: any) => !l.optional), freight = main.filter((l: any) => l.section !== 'local'), local = main.filter((l: any) => l.section === 'local');
    rows(freight);
    if (local.length) { if (freight.length) subHead('Local charges'); rows(local); }
    room(26);
    const label = o.option_no ? `Option ${o.option_no} total` : 'Total', amt = `${d.currency} ${money(o.total)}`;
    y -= 4;
    page.drawText(label, { x: W - M - 120 - bold.widthOfTextAtSize(label, 10.5), y, size: 10.5, font: bold, color: NAVY });
    page.drawText(amt, { x: W - M - 6 - bold.widthOfTextAtSize(amt, 11), y, size: 11, font: bold, color: NAVY });
    y -= 22;
    const extra = o.lines.filter((l: any) => l.optional);
    if (extra.length) { subHead('If applicable (not included in the total)'); rows(extra); y -= 6; }
    y -= 4;
  }
  if (d.options) para('Please tell us which option you choose.', M, W - 2 * M, 9, font, GREY);
  if (c.quote_vat_note) para(c.quote_vat_note, M, W - 2 * M, 9, font, GREY);
  y -= 6;
  // ---- terms
  for (const [title, body] of [['Scope of service', d.scope], ['Exclusions', d.exclusions], ['Terms and conditions', d.terms], ['Payment / commercial conditions', d.payment_terms], ['Additional remarks', d.additional_remarks]] as [string, string][]) {
    if (!body) continue;
    room(30); text(title, M, 10, bold, NAVY); y -= 14;
    para(body, M, W - 2 * M, 9, font, BLACK); y -= 8;
  }
  room(30); y -= 6;
  para(`Prepared by ${d.prepared_by}${d.prepared_by_email ? ` · ${d.prepared_by_email}` : ''}`, M, W - 2 * M, 9, font, GREY);
  footer();
  return { bytes: await pdf.save(), filename: `Quotation ${d.quote_no}.pdf`.replace(/[\\/:*?"<>|]/g, '-'), quote_no: d.quote_no };
}
