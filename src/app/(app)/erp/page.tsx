'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime, fmtMoney } from '@/components/api';

const BATCH: Record<string, [string, string]> = { exported: ['Exported — waiting for ERP', '#B7791F'], confirmed: ['Confirmed in ERP', '#22543D'], partly_rejected: ['Some lines rejected', '#C05621'] };

export default function Erp() {
  const [d, setD] = useState<any>(null);
  const [types, setTypes] = useState<string[]>([]);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const load = () => api('/api/erp').then((x) => { setD(x); if (!types.length) setTypes(Object.keys(x.types)); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  if (!d) return <div className="page">{err ? <div className="msg err">{err}</div> : <p className="muted">Loading…</p>}</div>;
  const shown = d.ready.filter((i: any) => types.includes(i.source_type));
  const create = async () => { setErr(''); setOk(''); try { const b = await api('/api/erp', { body: { types } }); setOk(`${b.batch_no} created with ${b.record_count} record(s). Download it below and import it into the ERP.`); load(); } catch (e: any) { setErr(e.message); } };
  return (
    <div className="page">
      <div className="page-head"><h1>ERP export</h1></div>
      <p className="muted small" style={{ marginTop: -6 }}>Finished work handed to the ERP for invoicing and payables, as a CSV or Excel file. Each record goes out once; a line the ERP rejects comes back here to send again.</p>
      <div className="kpis">{Object.entries(d.types).map(([k, n]: any) => <div key={k} className="kpi"><b>{d.ready_by_type[k]}</b><span>{n} ready</span></div>)}
        <div className="kpi"><b>{d.counts.exported}</b><span>Waiting for ERP result</span></div><div className="kpi"><b>{d.counts.confirmed}</b><span>Confirmed in ERP</span></div>
        <div className="kpi attn"><b>{d.counts.rejected}</b><span>Rejected by ERP</span></div></div>
      {err && <div className="msg err">{err}</div>}{ok && <div className="msg ok">{ok}</div>}
      <div className="panel" style={{ marginTop: 12 }}><div className="page-head" style={{ marginBottom: 8 }}><h2 style={{ margin: 0 }}>Ready to send</h2><span className="spacer" />
        {d.can.export && <button className="btn primary" disabled={!shown.length} onClick={create}>Create export ({shown.length})</button>}</div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginBottom: 8 }}>{Object.entries(d.types).map(([k, n]: any) =>
          <label key={k} className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto' }} checked={types.includes(k)}
            onChange={(e) => setTypes(e.target.checked ? [...types, k] : types.filter((x) => x !== k))} />{n}</label>)}</div>
        <div className="table-wrap"><table className="t"><thead><tr><th>Reference</th><th>Type</th><th>Date</th><th>Customer / vendor</th><th>Job No.</th><th>Description</th>
          <th className="num">Qty</th><th className="num">Selling</th><th className="num">Cost</th></tr></thead>
          <tbody>{shown.slice(0, 200).map((i: any) => <tr key={i.external_ref}><td className="small">{i.external_ref}</td><td className="small">{i.type}</td><td>{fmtDate(i.date)}</td>
            <td>{i.customer}</td><td>{i.job_no || '—'}</td><td className="small">{i.description}</td><td className="num">{i.quantity} {i.unit}</td>
            <td className="num">{i.selling_amount ? fmtMoney(i.selling_amount, '') : '—'}</td><td className="num">{i.cost_amount ? fmtMoney(i.cost_amount, '') : '—'}</td></tr>)}
            {shown.length === 0 && <tr><td colSpan={9} className="muted" style={{ padding: 18, textAlign: 'center' }}>Nothing waiting.</td></tr>}</tbody></table></div>
        {shown.length > 200 && <p className="muted small">Showing 200 of {shown.length}; the export takes them all.</p>}</div>
      <div className="panel"><h2>Exports</h2><div className="table-wrap"><table className="t"><thead><tr><th>Export</th><th>Created</th><th className="num">Records</th><th>ERP reference</th><th>Status</th><th /></tr></thead>
        <tbody>{d.batches.map((b: any) => <tr key={b.id}><td><Link href={`/erp/${b.id}`}><b>{b.batch_no}</b></Link></td><td>{fmtDateTime(b.created_at)}<div className="muted small">{b.created_by_name}</div></td>
          <td className="num">{b.record_count}{b.rejected > 0 && <div className="flag">{b.rejected} rejected</div>}</td><td>{b.erp_reference ?? '—'}</td>
          <td><span className="badge" style={{ background: BATCH[b.status][1] }}>{BATCH[b.status][0]}</span></td>
          <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}><a className="btn small" href={`/api/erp/${b.id}?format=xlsx`}>Excel</a> <a className="btn small" href={`/api/erp/${b.id}?format=csv`}>CSV</a></td></tr>)}
          {d.batches.length === 0 && <tr><td colSpan={6} className="muted">No exports yet.</td></tr>}</tbody></table></div></div>
    </div>
  );
}
