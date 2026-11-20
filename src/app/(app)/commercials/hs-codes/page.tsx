'use client';
/** Migration 036: the HS code list (Dubai Customs "Tariff Report") — what is loaded, upload a newer one, check codes. */
import { useEffect, useState } from 'react';
import { api } from '@/components/api';
import { HsCheck } from '@/components/HsCheck';

export default function HsCodes() {
  const [info, setInfo] = useState<any>(undefined);
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [codes, setCodes] = useState('');
  useEffect(() => { api('/api/hs-codes').then((r) => setInfo(r.info)).catch(() => setInfo(null)); }, []);
  const pick = (f: File | undefined) => {
    setMsg(null);
    if (!f) return setFile(null);
    if (!/\.xlsx$/i.test(f.name)) return setMsg({ ok: false, text: 'Choose the Tariff Report as an Excel file (.xlsx).' });
    if (f.size > 4 * 1024 * 1024) return setMsg({ ok: false, text: 'The file is bigger than 4 MB (the Tariff Report is about 1 MB).' });
    const r = new FileReader(); r.onload = () => setFile({ name: f.name, data: String(r.result) }); r.readAsDataURL(f);
  };
  const load = async () => {
    if (!file) return;
    setBusy(true); setMsg(null);
    try { const r = await api('/api/hs-codes', { body: { file: file.data, name: file.name } }); setInfo(r.info); setMsg({ ok: true, text: 'Loaded.' }); }
    catch (e: any) { setMsg({ ok: false, text: e.message }); }
    setBusy(false);
  };
  return (
    <div className="page" style={{ maxWidth: 900 }}>
      <div className="page-head"><h1>HS codes</h1></div>
      <p className="muted" style={{ marginTop: -6 }}>The UAE customs tariff. Every HS code on an enquiry is checked against this list:
        duty %, active or not, prohibited or restricted (and by which authority) — or "Not in our record".</p>
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Loaded list</h2>
        {info === undefined ? <div className="muted">Loading…</div> : !info ? <div className="msg warn">No list loaded yet. Upload the Tariff Report below.</div>
          : <dl className="kv">
            <dt>File</dt><dd>{info.file}</dd>
            <dt>As on</dt><dd>{info.as_of ?? '—'}</dd>
            <dt>HS codes</dt><dd>{info.codes.toLocaleString()} ({info.active.toLocaleString()} active)</dd>
            <dt>Prohibited / restricted lines</dt><dd>{info.controls == null ? 'Not in this file' : info.controls.toLocaleString()}</dd>
            <dt>Loaded</dt><dd>{new Date(info.loaded_at).toLocaleString()} by {info.loaded_by}</dd>
          </dl>}
      </div>
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Upload the Tariff Report</h2>
        <p className="small" style={{ marginTop: 0 }}>The Excel from Dubai Customs with the tabs "HSCode" (all codes) and "PR" (prohibited / restricted).
          Uploading a newer one updates the codes and replaces the prohibited / restricted list. Nothing is added twice.</p>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="file" accept=".xlsx" onChange={(e) => pick(e.target.files?.[0])} style={{ width: 'auto' }} />
          <button className="btn primary" disabled={!file || busy} onClick={load}>{busy ? 'Loading…' : 'Load'}</button>
        </div>
        {msg && <div className={`msg ${msg.ok ? 'ok' : 'err'}`}>{msg.text}</div>}
      </div>
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Check HS codes</h2>
        <label className="f"><span>HS codes (4 to 12 digits, separated by commas)</span>
          <input value={codes} onChange={(e) => setCodes(e.target.value)} placeholder="e.g. 6404, 6404.11.00, 8471300000" /></label>
        <HsCheck codes={codes} />
      </div>
    </div>
  );
}
