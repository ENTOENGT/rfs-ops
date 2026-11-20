/**
 * Reading an email's attachments for the AI (20 Nov fix): customers often put the shipment details in an attached sheet.
 *   Excel (.xlsx / .xlsm), CSV / text and Word (.docx)  → turned into plain text here
 *   PDF and pictures (png / jpg / gif / webp)           → sent to Claude as they are (Claude reads PDFs and pictures itself)
 *   anything else (old .xls, .doc, zip…)                → named in a note ("save it as .xlsx")
 * Limits keep it quick (the hosting cuts requests at 10 seconds): at most 3 attachments, 3 MB each, 16,000 characters of text.
 * Nothing is saved: the text only goes into the AI's reading of this one email.
 */
import { graph } from './outlook';

const MAX_FILES = 3, MAX_BYTES = 3 * 1024 * 1024, MAX_TEXT = 16000;
const IMAGE = /^image\/(png|jpe?g|gif|webp)$/i;
const ext = (n: string) => (n.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '');

export type Read = { blocks: any[]; text: string; notes: string[]; names: string[] };

async function xlsxText(buf: Buffer) {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf as any);
  const out: string[] = [];
  wb.eachSheet((ws) => {
    if (out.join('\n').length > MAX_TEXT) return;
    const rows: string[] = [];
    ws.eachRow({ includeEmpty: false }, (r, n) => {
      if (n > 300) return;
      const cells = (r.values as any[]).slice(1).map((v) => {
        if (v === null || v === undefined) return '';
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        if (typeof v === 'object') return String(v.text ?? v.result ?? (v.richText ? v.richText.map((t: any) => t.text).join('') : ''));
        return String(v);
      }).map((x) => x.trim());
      // merged cells repeat the same text in every cell they cover: keep it once
      const uniq = cells.filter((c, i) => c && c !== cells[i - 1]);
      if (uniq.length) rows.push(uniq.join(' | '));
    });
    if (rows.length) out.push(`[Sheet: ${ws.name}]\n${rows.join('\n')}`);
  });
  return out.join('\n\n');
}
async function docxText(buf: Buffer) {
  const JSZip = (await import('jszip')).default;
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml')?.async('string');
  if (!xml) return '';
  return xml.replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\n{3,}/g, '\n\n').trim();
}

/** The attachments of one message in this person's mailbox, ready for the AI. Never throws: problems become notes. */
export async function readAttachments(userId: string, msMessageId: string): Promise<Read> {
  const res: Read = { blocks: [], text: '', notes: [], names: [] };
  let list: any[] = [];
  try {
    const r: any = await graph(userId, `/me/messages/${encodeURIComponent(msMessageId)}/attachments?$select=id,name,contentType,size,isInline`);
    list = (r?.value ?? []).filter((a: any) => a['@odata.type'] !== '#microsoft.graph.itemAttachment' && !a.isInline);
  } catch { res.notes.push('The attachments could not be opened from Outlook.'); return res; }
  const texts: string[] = [];
  for (const a of list.slice(0, MAX_FILES + 2)) {
    const name = String(a.name ?? 'attachment'), type = String(a.contentType ?? ''), e = ext(name);
    if (res.names.length >= MAX_FILES) { res.notes.push(`${name}: not read (only the first ${MAX_FILES} attachments are read)`); continue; }
    if (Number(a.size) > MAX_BYTES) { res.notes.push(`${name}: too big to read (over 3 MB)`); continue; }
    const readable = ['xlsx', 'xlsm', 'csv', 'txt', 'docx', 'pdf'].includes(e) || IMAGE.test(type);
    if (!readable) { res.notes.push(e === 'xls' ? `${name}: old Excel (.xls) can't be read — ask for it as .xlsx, or open it and fill in by hand` : `${name}: this kind of file can't be read`); continue; }
    try {
      const f: any = await graph(userId, `/me/messages/${encodeURIComponent(msMessageId)}/attachments/${encodeURIComponent(a.id)}`);
      const buf = Buffer.from(String(f?.contentBytes ?? ''), 'base64');
      if (!buf.length) { res.notes.push(`${name}: empty`); continue; }
      if (e === 'xlsx' || e === 'xlsm') texts.push(`[Attachment: ${name}]\n${await xlsxText(buf)}`);
      else if (e === 'csv' || e === 'txt') texts.push(`[Attachment: ${name}]\n${buf.toString('utf8')}`);
      else if (e === 'docx') texts.push(`[Attachment: ${name}]\n${await docxText(buf)}`);
      else if (e === 'pdf') res.blocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buf.toString('base64') }, title: name });
      else res.blocks.push({ type: 'image', source: { type: 'base64', media_type: type.toLowerCase().replace('jpg', 'jpeg'), data: buf.toString('base64') } });
      res.names.push(name);
    } catch { res.notes.push(`${name}: could not be read`); }
  }
  res.text = texts.join('\n\n').slice(0, MAX_TEXT);
  if (texts.join('\n\n').length > MAX_TEXT) res.notes.push('The attached sheet is long: only its first part was read.');
  return res;
}
