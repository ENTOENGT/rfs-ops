'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDateTime, fmtMoney } from '@/components/api';

export default function ErpBatch({ params }: { params: { id: string } }) {
  const [d, setD] = useState<any>(null);
  const [ref, setRef] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api(`/api/erp/${params.id}`).then(setD).catch((e) => setErr(e.message)); }, [params.id]);
  const act = async (body: any) => { setErr(''); try { setD(await api(`/api/erp/${params.id}`, { body })); } catch (e: any) { setErr(e.message); } };
  if (!d) return <div className="page">{err ? <div className="msg err">{err}</div> : <p className="muted">Loading…</p>}</div>;
  return (
    <div className="page">
      <div className="page-head"><h1>{d.batch_no}</h1><span className="spacer" /><Link className="btn" href="/erp">Back</Link>
        <a className="btn" href={`/api/erp/${d.id}?format=xlsx`}>Excel</a><a className="btn" href={`/api/erp/${d.id}?format=csv`}>CSV</a></div>
      {err && <div className="msg err">{err}</div>}
      <p className="small">Created {fmtDateTime(d.created_at)} by {d.created_by_name} · {d.record_count} record(s){d.erp_reference && <> · ERP reference <b>{d.erp_reference}</b> ({fmtDateTime(d.confirmed_at)})</>}</p>
      {d.can.export && !d.erp_reference && <div className="panel"><h2>After importing into the ERP</h2>
        <p className="small muted" style={{ marginTop: 0 }}>Type the ERP's import or journal number to confirm every line. Reject single lines first if the ERP refused them — they become ready to send again.</p>
        <div style={{ display: 'flex', gap: 8 }}><input value={ref} onChange={(e) => setRef(e.target.value)} placeholder="ERP reference" style={{ maxWidth: 260 }} />
          <button className="btn primary" disabled={!ref.trim()} onClick={() => act({ what: 'confirm', erp_reference: ref })}>Confirm in ERP</button></div></div>}
      <div className="panel flush"><div className="table-wrap"><table className="t"><thead><tr><th>Reference</th><th>Type</th><th>Customer / vendor</th><th>Description</th>
        <th className="num">Selling</th><th className="num">Cost</th><th>Status</th><th /></tr></thead>
        <tbody>{d.items.map((i: any) => <tr key={i.id}><td className="small">{i.external_ref}</td><td className="small">{i.payload.type}</td><td>{i.payload.customer}</td>
          <td className="small">{i.payload.description}</td><td className="num">{i.payload.selling_amount ? fmtMoney(i.payload.selling_amount, '') : '—'}</td>
          <td className="num">{i.payload.cost_amount ? fmtMoney(i.payload.cost_amount, '') : '—'}</td>
          <td>{i.status === 'rejected' ? <span className="flag">Rejected: {i.reject_reason}</span> : i.status === 'confirmed' ? 'Confirmed' : 'Exported'}</td>
          <td>{d.can.export && i.status === 'exported' && <button className="btn small" onClick={() => { const reason = prompt('Why did the ERP reject it?'); if (reason) act({ what: 'reject', item_id: i.id, reason }); }}>Rejected</button>}</td></tr>)}</tbody></table></div></div>
    </div>
  );
}
