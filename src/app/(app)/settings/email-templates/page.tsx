'use client';
import { useEffect, useRef, useState } from 'react';
import { api, fmtDateTime } from '@/components/api';
import { useMe } from '@/components/Shell';
import { DIVISIONS, divisionName } from '@/lib/commercialRules';
import { PLACEHOLDERS, TEMPLATE_MODES, badPlaceholders } from '@/lib/templateRules';

const WHO: Record<string, string> = { vendor: 'To agent / carrier', quotation: 'Quotation to customer', shipment: 'To customer' };

/**
 * The 16 standard emails. Each has the standard text until you save your own; you can also save a version for one
 * division, mode or customer (the most specific wins). The subject must keep {{ThreadSubject}} so every email about a
 * shipment stays in one conversation with its Enquiry Ref.
 */
export default function EmailTemplates() {
  const { lk } = useMe();
  const [d, setD] = useState<any>(null);
  const [f, setF] = useState<any>(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const load = () => api('/api/templates/emails').then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const start = (key: string, t?: any) => {
    const b = d.built_in.find((x: any) => x.key === key);
    setF(t ? { ...t, ctx: b.ctx } : { template_key: key, ctx: b.ctx, division: '', mode: '', customer_id: '', subject: b.subject, body: b.body, is_active: true });
    setErr(''); setOk(''); window.scrollTo(0, 0);
  };
  const insert = (p: string) => {
    const el = bodyRef.current; const tag = `{{${p}}}`;
    if (!el) return setF({ ...f, body: f.body + tag });
    const s = el.selectionStart ?? f.body.length;
    setF({ ...f, body: f.body.slice(0, s) + tag + f.body.slice(el.selectionEnd ?? s) });
  };
  const save = async () => {
    setErr(''); setOk('');
    try { await api('/api/templates/emails', { body: { ...f, division: f.division || null, mode: f.mode || null, customer_id: f.customer_id || null } });
      setF(null); setOk('Template saved. Emails made from now on use it.'); load(); }
    catch (e: any) { setErr(e.message); window.scrollTo(0, 0); }
  };
  if (!d) return <div className="page">{err ? <div className="msg err">{err}</div> : <p className="muted">Loading…</p>}</div>;
  const wrong = f ? badPlaceholders(`${f.subject}\n${f.body}`, f.ctx) : [];
  return (
    <div className="page">
      <div className="page-head"><h1>Email templates</h1></div>
      <p className="muted" style={{ marginTop: 0 }}>Placeholders like {'{{VesselName}}'} are filled from the shipment when someone presses Email. Anything not known yet is shown in [brackets] and listed in red, so it can be filled in before sending.</p>
      {err && <div className="msg err">{err}</div>}{ok && <div className="msg ok">{ok}</div>}
      {f && <div className="panel"><h2>{d.built_in.find((x: any) => x.key === f.template_key)?.name} <span className="muted small">({WHO[f.ctx]})</span></h2>
        <div className="grid g4">
          <label className="f"><span>Division</span><select value={f.division ?? ''} onChange={(e) => setF({ ...f, division: e.target.value })}><option value="">Any</option>
            {DIVISIONS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="f"><span>Mode</span><select value={f.mode ?? ''} onChange={(e) => setF({ ...f, mode: e.target.value })}><option value="">Any</option>
            {TEMPLATE_MODES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          {f.ctx !== 'vendor' && <label className="f"><span>Only for this customer</span><select value={f.customer_id ?? ''} onChange={(e) => setF({ ...f, customer_id: e.target.value })}><option value="">Any customer</option>
            {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>}
          <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> In use</label>
        </div>
        <label className="f"><span>Subject (keep {'{{ThreadSubject}}'})</span><input value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} /></label>
        <div className="cols" style={{ gridTemplateColumns: 'minmax(0, 2fr) minmax(0, 1fr)' }}>
          <label className="f"><span>Email text</span><textarea ref={bodyRef} rows={16} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} style={{ fontFamily: 'inherit' }} /></label>
          <div className="small"><b>Insert a placeholder</b> <span className="muted">(at the cursor)</span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 6, maxHeight: 340, overflowY: 'auto' }}>
              {PLACEHOLDERS.filter(([, , ctx]) => ctx.includes(f.ctx)).map(([p, what]) => <button key={p} type="button" className="linkish" style={{ textAlign: 'left' }} title={what} onClick={() => insert(p)}>
                {`{{${p}}}`} <span className="muted">— {what}</span></button>)}</div></div>
        </div>
        {wrong.length > 0 && <div className="msg err small">Not allowed in this email: {wrong.map((w) => `{{${w}}}`).join(', ')}</div>}
        <div className="form-actions"><button className="btn" onClick={() => setF(null)}>Cancel</button>
          <button className="btn primary" disabled={wrong.length > 0} onClick={save}>Save template</button></div>
      </div>}
      <div className="table-wrap"><table className="t"><thead><tr><th>Email</th><th>Goes to</th><th>Your templates</th><th /></tr></thead>
        <tbody>{d.built_in.map((b: any) => { const mine = d.rows.filter((t: any) => t.template_key === b.key); return <tr key={b.key}>
          <td><b>{b.name}</b></td><td className="small">{WHO[b.ctx]}</td>
          <td className="small">{mine.length === 0 ? <span className="muted">Standard text</span> : mine.map((t: any) => <div key={t.id}>
            <button className="linkish" onClick={() => start(b.key, t)}>{[t.division && divisionName(t.division), t.mode && TEMPLATE_MODES.find(([k]) => k === t.mode)?.[1], t.customer_name].filter(Boolean).join(' · ') || 'All shipments'}</button>
            {!t.is_active && <span className="muted"> (switched off)</span>} <span className="muted">· {fmtDateTime(t.updated_at)}</span></div>)}</td>
          <td><button className="btn small" onClick={() => start(b.key)}>{mine.length ? 'Add another' : 'Customise'}</button></td></tr>; })}</tbody></table></div>
      {d.history.length > 0 && <details style={{ marginTop: 14 }}><summary className="small">Change history ({d.history.length})</summary>
        {d.history.map((h: any, i: number) => <div key={i} className="small" style={{ padding: '3px 0' }}>{fmtDateTime(h.at)} — {h.action} · {h.user_name}</div>)}</details>}
    </div>
  );
}
