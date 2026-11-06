'use client';
import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '@/components/api';
import { useMe } from '@/components/Shell';
import { DIVISIONS, divisionName } from '@/lib/commercialRules';
import { TERM_FIELDS, TEMPLATE_MODES, SHIPMENT_TYPES } from '@/lib/templateRules';

const blank = { name: '', division: '', mode: '', shipment_type: '', customer_id: '', is_active: true, scope: '', exclusions: '', terms: '', additional_remarks: '', payment_terms: '' };
const label = (list: [string, string][], v: string | null) => (v ? list.find(([k]) => k === v)?.[1] ?? v : 'Any');

/**
 * Default Scope, Exclusions, Terms, Remarks and Payment conditions for new quotations. The most specific active template
 * wins (one customer > division + mode + FCL/LCL > division > any). Changing a template never changes a quotation already made.
 */
export default function QuoteTerms() {
  const { lk } = useMe();
  const [d, setD] = useState<any>(null);
  const [f, setF] = useState<any>(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const load = () => api('/api/templates/terms').then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  const save = async () => {
    setErr(''); setOk('');
    try { await api('/api/templates/terms', { body: { ...f, division: f.division || null, mode: f.mode || null, shipment_type: f.shipment_type || null, customer_id: f.customer_id || null } });
      setF(null); setOk('Template saved. New quotations use it from now on; quotations already made are not changed.'); load(); }
    catch (e: any) { setErr(e.message); window.scrollTo(0, 0); }
  };
  if (!d) return <div className="page">{err ? <div className="msg err">{err}</div> : <p className="muted">Loading…</p>}</div>;
  return (
    <div className="page">
      <div className="page-head"><h1>Quotation terms</h1><span className="spacer" />
        {d.can_manage && !f && <button className="btn primary" onClick={() => setF({ ...blank })}>New template</button>}</div>
      <p className="muted" style={{ marginTop: 0 }}>A new quotation is filled from the best matching template: a customer's own template first, then the one for its division, mode and FCL / LCL, then the general one. The Coordinator can still change the texts on each quotation.</p>
      {err && <div className="msg err">{err}</div>}{ok && <div className="msg ok">{ok}</div>}
      {f && <div className="panel"><h2>{f.id ? 'Change template' : 'New template'}</h2>
        <div className="grid g4">
          <label className="f span2"><span>Name *</span><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Imports – Sea FCL standard" /></label>
          <label className="f"><span>Division</span><select value={f.division ?? ''} onChange={(e) => setF({ ...f, division: e.target.value })}><option value="">Any</option>
            {DIVISIONS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="f"><span>Mode</span><select value={f.mode ?? ''} onChange={(e) => setF({ ...f, mode: e.target.value, shipment_type: e.target.value === 'sea' ? f.shipment_type : '' })}><option value="">Any</option>
            {TEMPLATE_MODES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="f"><span>FCL / LCL</span><select value={f.shipment_type ?? ''} disabled={f.mode !== 'sea'} onChange={(e) => setF({ ...f, shipment_type: e.target.value })}><option value="">Any</option>
            {SHIPMENT_TYPES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="f"><span>Only for this customer</span><select value={f.customer_id ?? ''} onChange={(e) => setF({ ...f, customer_id: e.target.value })}><option value="">Any customer</option>
            {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> In use</label>
        </div>
        <div className="grid g2">{TERM_FIELDS.map(([k, n]) => <label key={k} className="f"><span>{n}</span>
          <textarea rows={5} value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>)}</div>
        <div className="form-actions"><button className="btn" onClick={() => setF(null)}>Cancel</button><button className="btn primary" onClick={save}>Save template</button></div>
      </div>}
      <div className="table-wrap"><table className="t"><thead><tr><th>Template</th><th>Division</th><th>Mode</th><th>Customer</th><th>Status</th><th>Last changed</th><th /></tr></thead>
        <tbody>{d.rows.map((t: any) => <tr key={t.id} className={t.is_active ? '' : 'muted'}>
          <td><b>{t.name}</b><div className="muted small">{TERM_FIELDS.filter(([k]) => t[k]).map(([, n]) => n).join(', ')}</div></td>
          <td>{t.division ? divisionName(t.division) : 'Any'}</td><td>{label(TEMPLATE_MODES, t.mode)}{t.shipment_type && ` ${label(SHIPMENT_TYPES, t.shipment_type)}`}</td>
          <td>{t.customer_name ?? 'Any'}</td><td>{t.is_active ? 'In use' : 'Switched off'}</td>
          <td className="small">{fmtDateTime(t.updated_at)}{t.updated_by_name && ` · ${t.updated_by_name}`}</td>
          <td>{d.can_manage && <button className="btn small" onClick={() => { setF({ ...blank, ...t }); window.scrollTo(0, 0); }}>Change</button>}</td></tr>)}
          {d.rows.length === 0 && <tr><td colSpan={7} className="muted">No templates yet. Until you add one, quotations start with empty terms.</td></tr>}</tbody></table></div>
      {d.history.length > 0 && <details style={{ marginTop: 14 }}><summary className="small">Change history ({d.history.length})</summary>
        {d.history.map((h: any, i: number) => <div key={i} className="small" style={{ padding: '3px 0' }}>{fmtDateTime(h.at)} — {h.action}: {d.rows.find((t: any) => t.id === h.template_id)?.name ?? ''} · {h.user_name}</div>)}</details>}
    </div>
  );
}
