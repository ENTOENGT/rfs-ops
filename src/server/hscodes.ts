/**
 * Migration 036 — the HS code list (UAE customs tariff) and prohibitions / restrictions, from Dubai Customs' "Tariff Report".
 *
 * Upload (Commercials → HS codes): the tab with the HS codes ("HSCode": every code with duty %, Active / In Active…) and the
 * "PR" tab (prohibited / restricted). Codes come back as numbers from Excel, so leading zeros are put back (8 digits).
 * A newer report updates the codes (same code = updated, new code = added) and replaces the prohibition list.
 *
 * Check: for each HS code the customer gives — 4 or 6 digits (a heading: every code under it), 8 digits (that code), or
 * 10 / 12 digits (its first 8) — the duty %, the status, any prohibition / restriction with its authority, or
 * "not in our record".
 */
import { Actor } from './auth';
import { audit, bad, forbidden, getSetting, q, tx } from './db';

export const canManageHs = (a: Actor) => a.isSuperAdmin || a.has('settings.manage') || a.has('commercial.manage');
const digits = (v: unknown) => String(v ?? '').replace(/[^0-9]/g, '');
/** Excel turns 01011010 into 1011010: put the leading zero back (3 / 7 / 9 / 11 digits get one). */
export const pad = (code: unknown) => { const d = digits(code); return [3, 7, 9, 11].includes(d.length) ? `0${d}` : d; };

function text(v: any): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object') return String(v.text ?? v.result ?? (v.richText ? v.richText.map((t: any) => t.text).join('') : ''));
  return String(v);
}
const day = (v: any) => { const s = text(v); const d = s ? new Date(s) : null; return d && !isNaN(+d) ? d.toISOString().slice(0, 10) : null; };
const num = (v: any) => { const s = text(v).replace('%', '').trim(); if (s === '') return null; const n = Number(s); return Number.isFinite(n) ? n : null; };

/** Find the heading row (the one with "HSCode") and map column names to positions. */
function table(ws: any, need: string[]) {
  for (let r = 1; r <= 12; r++) {
    const row = ws.getRow(r).values as any[];
    const names = row.map((v) => text(v).trim().toLowerCase());
    if (need.every((n) => names.includes(n))) return { head: r, col: (n: string) => names.indexOf(n.toLowerCase()) };
  }
  return null;
}

/** Upload the Tariff Report (.xlsx as base64). */
export async function importTariff(actor: Actor, b: any) {
  if (!canManageHs(actor)) throw forbidden('Only the Super Admin or the Commercials Manager loads the HS code list');
  const raw = String(b?.file ?? '');
  if (!raw) throw bad('Choose the Tariff Report (.xlsx)');
  const buf = Buffer.from(raw.replace(/^data:[^,]*,/, ''), 'base64');
  if (buf.length > 4 * 1024 * 1024) throw bad('The file is bigger than 4 MB');
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  try { await wb.xlsx.load(buf as any); } catch { throw bad('This is not an Excel file (.xlsx)'); }
  // the codes: the tab with HSCode + Duty % (the full "HSCode" tab if there; it already has the Active ones)
  let codesWs: any = null, ct: any = null, asOf = '';
  for (const ws of wb.worksheets) {
    const t = table(ws, ['hscode', 'duty %']);
    if (t && (!codesWs || /^hs\s*code$/i.test(ws.name.trim()))) { codesWs = ws; ct = t; }
  }
  if (!codesWs) throw bad('No HS code tab found (a tab with the columns "HSCode" and "Duty %")');
  // the report's date, from its title ("List of All HSCodes as on 03rd February 2022")
  for (let r = 1; r < ct.head && !asOf; r++) for (const v of (codesWs.getRow(r).values as any[]) ?? []) { const m = text(v).match(/as on (.+)$/i); if (m) { asOf = m[1].trim(); break; } }
  const tariff = new Map<string, any>();
  codesWs.eachRow((r: any, i: number) => {
    if (i <= ct.head) return;
    const v = r.values as any[];
    const code = pad(v[ct.col('hscode')]);
    if (code.length < 6 || code.length > 12) return;
    const row = { code, description: text(v[ct.col('short desc')]).trim().slice(0, 500) || null, duty_pct: num(v[ct.col('duty %')]),
      original_duty_pct: num(v[ct.col('original duty %')]), service_charge_pct: num(v[ct.col('service charge %')]), status: text(v[ct.col('status')]).trim() || null,
      effective_from: day(v[ct.col('effective from')]), effective_to: day(v[ct.col('effective to')]),
      is_vehicle: /^y/i.test(text(v[ct.col('is vehicle')])) ? true : /^n/i.test(text(v[ct.col('is vehicle')])) ? false : null,
      grp: text(v[ct.col('group')]).trim() || null, last_updated: text(v[ct.col('last updated on')]) || null };
    const old = tariff.get(code);
    if (!old || (row.status === 'Active' && old.status !== 'Active')) tariff.set(code, row);     // an active line wins over an old one
  });
  // prohibitions / restrictions: the tab with HSCode + Action Type
  let prWs: any = null, pt: any = null;
  for (const ws of wb.worksheets) { const t = table(ws, ['hscode', 'action type']); if (t) { prWs = ws; pt = t; break; } }
  const controls: any[] = [];
  prWs?.eachRow((r: any, i: number) => {
    if (i <= pt.head) return;
    const v = r.values as any[];
    const code = pad(v[pt.col('hscode')]);
    if (code.length < 6) return;
    const fp = text(v[pt.col('fully prohibited')]).trim();
    controls.push({ code, description: text(v[pt.col('hscode desc')]).trim().slice(0, 500) || null, action_type: text(v[pt.col('action type')]).trim().toUpperCase().slice(0, 5) || null,
      fully_prohibited: /^y/i.test(fp) ? true : /^n/i.test(fp) ? false : null, authority: text(v[pt.col('controling authority')] ?? v[pt.col('controlling authority')]).trim() || null,
      remarks: text(v[pt.col('remarks')]).trim().slice(0, 1000) || null, start_date: day(v[pt.col('start date')]), end_date: day(v[pt.col('end date')]),
      status: text(v[pt.col('status')]).trim() || null, action_indicator: text(v[pt.col('action indicator')]).trim() || null });
  });
  if (!tariff.size) throw bad('The HS code tab has no codes');
  const rows = [...tariff.values()];
  await tx(async (c) => {
    const K = ['code', 'description', 'duty_pct', 'original_duty_pct', 'service_charge_pct', 'status', 'effective_from', 'effective_to', 'is_vehicle', 'grp', 'last_updated'];
    const T = ['text', 'text', 'numeric', 'numeric', 'numeric', 'text', 'date', 'date', 'boolean', 'text', 'timestamptz'];
    for (let i = 0; i < rows.length; i += 2000) {
      const part = rows.slice(i, i + 2000);
      await c.query(`insert into hs_tariff (${K.join(', ')}, loaded_at) select *, now() from unnest(${K.map((_, j) => `$${j + 1}::${T[j]}[]`).join(', ')})
        on conflict (code) do update set ${K.slice(1).map((k) => `${k} = excluded.${k}`).join(', ')}, loaded_at = now()`, K.map((k) => part.map((r) => r[k])));
    }
    if (prWs) {
      await c.query('delete from hs_controls');               // the prohibition list is replaced by the newer report
      const P = ['code', 'description', 'action_type', 'fully_prohibited', 'authority', 'remarks', 'start_date', 'end_date', 'status', 'action_indicator'];
      const PT = ['text', 'text', 'text', 'boolean', 'text', 'text', 'date', 'date', 'text', 'text'];
      for (let i = 0; i < controls.length; i += 2000) {
        const part = controls.slice(i, i + 2000);
        await c.query(`insert into hs_controls (${P.join(', ')}) select * from unnest(${P.map((_, j) => `$${j + 1}::${PT[j]}[]`).join(', ')})`, P.map((k) => part.map((r) => r[k])));
      }
    }
    const info = { file: String(b?.name ?? 'Tariff Report').slice(0, 120), as_of: asOf || null, codes: rows.length, active: rows.filter((r) => r.status === 'Active').length,
      controls: prWs ? controls.length : null, loaded_at: new Date().toISOString(), loaded_by: actor.full_name };
    await c.query(`insert into settings (key, value, updated_by, updated_at) values ('hs_tariff_info', $1, $2, now())
      on conflict (key) do update set value = excluded.value, updated_by = excluded.updated_by, updated_at = now()`, [JSON.stringify(info), actor.id]);
    await audit(c, actor, { entity_type: 'setting', entity_id: null, action: 'HS code list loaded', sensitivity: 'admin',
      new_value: `${rows.length} codes (${info.active} active), ${prWs ? controls.length : 'no'} prohibition / restriction lines${asOf ? `, as on ${asOf}` : ''}` });
  });
  return hsInfo();
}

export async function hsInfo() {
  return { info: await getSetting<any>('hs_tariff_info', null) };
}

export type HsResult = {
  input: string; code: string; level: 'heading' | 'code' | 'invalid'; found: boolean; message: string;
  codes: { code: string; description: string | null; duty_pct: number | null; status: string | null }[]; more: number;
  controls: { code: string; description: string | null; action_type: string | null; fully_prohibited: boolean | null; authority: string | null; remarks: string | null }[];
};

/** Check HS codes (any separators; 4–12 digits). Each input once. */
export async function checkHs(input: unknown): Promise<{ loaded: boolean; results: HsResult[] }> {
  const list = (Array.isArray(input) ? input : String(input ?? '').split(/[,;\n]+/)).map((s) => String(s).trim()).filter(Boolean);
  const loaded = !!(await q('select 1 from hs_tariff limit 1'))[0];
  const seen = new Set<string>(); const results: HsResult[] = [];
  for (const raw of list.slice(0, 30)) {
    const d = pad(raw);
    if (seen.has(d)) continue; seen.add(d);
    if (d.length < 4 || d.length > 12) { results.push({ input: raw, code: d, level: 'invalid', found: false, message: 'Not an HS code (4 to 12 digits)', codes: [], more: 0, controls: [] }); continue; }
    const key = d.length > 8 ? d.slice(0, 8) : d;
    const heading = key.length < 8;
    const codes = await q(`select code, description, duty_pct::float duty_pct, status from hs_tariff where ${heading ? 'code like $1 || \'%\'' : 'code = $1'}
      order by (status = 'Active') desc, code limit 11`, [key]);
    const total = heading ? Number((await q(`select count(*) n from hs_tariff where code like $1 || '%'`, [key]))[0].n) : codes.length;
    const controls = await q(`select code, description, action_type, fully_prohibited, authority, remarks from hs_controls
      where coalesce(status, 'A') = 'A' and (end_date is null or end_date >= current_date) and ${heading ? 'code like $1 || \'%\'' : 'code = $1'}
      order by (action_type = 'P') desc, code limit 10`, [key]);
    const active = codes.filter((c) => c.status === 'Active');
    const duties = [...new Set(active.map((c) => c.duty_pct))].sort((a, b) => (a ?? 0) - (b ?? 0));
    const prohibited = controls.some((c) => c.action_type === 'P');
    let message: string;
    if (!loaded) message = 'The HS code list is not loaded yet';
    else if (!codes.length) message = 'Not in our record';
    else if (heading) message = `${total} code${total === 1 ? '' : 's'} under ${key}${duties.length ? ` · duty ${duties.length === 1 ? `${duties[0]}%` : `${duties[0]}–${duties[duties.length - 1]}%`}` : ' · none active'}`;
    else message = `${codes[0].status === 'Active' ? `Duty ${codes[0].duty_pct ?? '?'}%` : `${codes[0].status ?? 'Status unknown'} — not an active code`}${d.length > 8 ? ` (checked as ${key})` : ''}`;
    if (controls.length) message += prohibited ? ' · PROHIBITED' : ' · restricted';
    results.push({ input: raw, code: key, level: heading ? 'heading' : 'code', found: codes.length > 0, message, codes: codes.slice(0, 10), more: Math.max(0, total - 10), controls });
  }
  return { loaded, results };
}
