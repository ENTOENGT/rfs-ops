'use client';
/** Bulk upload of customers (with their main salesman and contacts) and vendors (with their coverage) from the Excel template. */
import { useState } from 'react';
import { api } from '@/components/api';

const STATUS: Record<string, [string, string]> = { new: ['New', 'ok'], exists: ['Already there', 'muted'], problem: ['Problem', 'flag'] };

export default function BulkUpload() {
  const [file, setFile] = useState<{ name: string; data: string } | null>(null);
  const [res, setRes] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [all, setAll] = useState<Record<string, boolean>>({});
  const pick = (f: File | undefined) => {
    setRes(null); setErr('');
    if (!f) return setFile(null);
    if (!/\.xlsx$/i.test(f.name)) { setErr('Choose the Excel file (.xlsx) made from the template.'); return; }
    if (f.size > 5 * 1024 * 1024) { setErr('The file is bigger than 5 MB. Split it into smaller files.'); return; }
    const r = new FileReader();
    r.onload = () => setFile({ name: f.name, data: String(r.result) });
    r.readAsDataURL(f);
  };
  const run = async (doImport: boolean) => {
    if (!file) return;
    if (doImport && !confirm(`Import ${res.summary.new} new row(s) and update ${res.summary.exists} existing? ${res.summary.problems ? `${res.summary.problems} row(s) with problems are skipped.` : ''}`)) return;
    setBusy(true); setErr('');
    try { setRes(await api('/api/bulk-upload', { body: { file: file.data, import: doImport } })); } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  return (
    <div className="page" style={{ maxWidth: 1100 }}>
      <div className="page-head"><h1>Bulk upload</h1></div>
      <p className="muted" style={{ marginTop: -6 }}>Add many customers (with their main salesman and contacts) and vendors (with where they work) at once.
        Nothing is ever added twice: a customer or vendor already in RFS CRM only gets its empty fields filled in.</p>
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>1. Download the template</h2>
        <p className="small" style={{ marginTop: 0 }}>Four sheets: Customers, Customer contacts, Vendors, Vendor coverage. The "Read me" sheet explains each column; the Lists sheet has the salesmen and choices.</p>
        <a className="btn" href="/api/bulk-upload/template">Download template (.xlsx)</a>
      </div>
      <div className="panel">
        <h2 style={{ marginTop: 0 }}>2. Choose the filled-in file and check it</h2>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => pick(e.target.files?.[0])} style={{ width: 'auto' }} />
          <button className="btn primary" disabled={!file || busy} onClick={() => run(false)}>{busy && !res ? 'Checking…' : 'Check'}</button>
        </div>
        <p className="muted small">Checking saves nothing. You see each row first.</p>
        {err && <div className="msg err">{err}</div>}
      </div>
      {res && <div className="panel">
        <h2 style={{ marginTop: 0 }}>{res.imported ? 'Imported' : '3. What will happen'}</h2>
        <div className={`msg ${res.imported ? 'ok' : res.summary.problems ? 'warn' : 'ok'}`}>
          {res.imported ? 'Done: ' : ''}<b>{res.summary.new}</b> new · <b>{res.summary.exists}</b> already there · <b>{res.summary.problems}</b> with problems{res.summary.problems ? (res.imported ? ' (skipped — fix them in the file and upload it again)' : ' — these rows will be skipped; you can fix them in the file and check again') : ''}
        </div>
        {res.sheets.map((s: any) => {
          const show = all[s.name] ? s.rows : s.rows.filter((r: any) => r.status !== 'new').slice(0, 200);
          const n = (k: string) => s.rows.filter((r: any) => r.status === k).length;
          return <div key={s.name} style={{ marginTop: 14 }}>
            <div className="page-head" style={{ marginBottom: 4, alignItems: 'baseline' }}><h3 style={{ margin: 0 }}>{s.name}</h3>
              <span className="muted small" style={{ marginLeft: 8 }}>{n('new')} new · {n('exists')} already there · {n('problem')} problems</span><span className="spacer" />
              <button className="linkish small" onClick={() => setAll({ ...all, [s.name]: !all[s.name] })}>{all[s.name] ? 'Show problems and existing only' : `Show all ${s.rows.length} rows`}</button></div>
            {show.length === 0 ? <div className="muted small" style={{ marginTop: 8 }}>All rows are new and fine.</div> : <div className="table-wrap"><table className="t">
              <thead><tr><th style={{ width: 60 }}>Row</th><th>Name</th><th style={{ width: 120 }}>Result</th><th>Details</th></tr></thead>
              <tbody>{show.map((r: any) => <tr key={r.row}><td className="small">{r.row}</td><td>{r.name}</td>
                <td><span className={`small ${STATUS[r.status][1]}`}><b>{STATUS[r.status][0]}</b></span></td><td className="small">{r.note}</td></tr>)}</tbody></table></div>}
          </div>;
        })}
        {!res.imported && <div className="actions">
          <button className="btn primary" disabled={busy || res.summary.new + res.summary.exists === 0} onClick={() => run(true)}>{busy ? 'Importing…' : `Import ${res.summary.new + res.summary.exists} row(s)`}</button></div>}
      </div>}
    </div>
  );
}
