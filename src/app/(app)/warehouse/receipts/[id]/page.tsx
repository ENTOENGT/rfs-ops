'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime } from '@/components/api';
import { GRN_STATUS, WhTabs, qtyFmt, useWhConfig } from '@/components/WarehouseShared';

export default function Receipt({ params }: { params: { id: string } }) {
  const { cfg } = useWhConfig();
  const [d, setD] = useState<any>(null);
  const [rx, setRx] = useState<Record<string, any>>({});
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const load = () => api(`/api/warehouse/receipts/${params.id}`).then((g) => {
    setD(g);
    setRx(Object.fromEntries(g.lines.map((l: any) => [l.id, { received_qty: String(Number(l.expected_qty)), damaged_qty: '0', batch_no: '', expiry_date: '', location_id: '' }])));
  }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [params.id]);
  const act = async (body: any, done: string) => {
    setErr(''); setOk('');
    try { setD(await api(`/api/warehouse/receipts/${params.id}`, { body })); setOk(done); } catch (e: any) { setErr(e.message); window.scrollTo(0, 0); }
  };
  if (!d) return <div className="page">{err ? <div className="msg err">{err}</div> : <p className="muted">Loading…</p>}</div>;
  const bins = cfg?.locations.filter((l: any) => l.warehouse_id === d.warehouse_id && l.is_active && l.location_type !== 'damaged') ?? [];
  const set = (id: string, k: string, v: string) => setRx({ ...rx, [id]: { ...rx[id], [k]: v } });
  return (
    <div className="page">
      <div className="page-head"><h1>{d.grn_no}</h1><span className="badge" style={{ background: GRN_STATUS[d.status][1] }}>{GRN_STATUS[d.status][0]}</span><span className="spacer" />
        {d.can.cancel && <button className="btn danger" onClick={() => { const reason = prompt('Cancel this receipt? Reason:'); if (reason) act({ action: 'cancel', reason }, 'Cancelled'); }}>Cancel receipt</button>}</div>
      <WhTabs />
      {err && <div className="msg err">{err}</div>}
      {ok && <div className="msg ok">{ok}</div>}
      <div className="panel"><dl className="kv">
        <dt>Customer</dt><dd>{d.customer_name}</dd><dt>Warehouse</dt><dd>{d.warehouse_code} — {d.warehouse_name}</dd>
        <dt>Job No.</dt><dd>{d.job_file_id ? <Link href={`/job-files/${d.job_file_id}`}>{d.job_no}</Link> : '—'}</dd>
        <dt>Supplier / reference</dt><dd>{[d.supplier, d.reference].filter(Boolean).join(' · ') || '—'}</dd>
        <dt>Expected</dt><dd>{fmtDate(d.expected_date)}</dd>
        {d.received_at && <><dt>Received</dt><dd>{fmtDateTime(d.received_at)} by {d.received_by_name}</dd></>}
        {d.cancel_reason && <><dt>Cancelled</dt><dd>{d.cancel_reason}</dd></>}
      </dl></div>
      <div className="panel"><h2>{d.can.receive ? 'Receive the goods' : 'Goods'}</h2>
        {d.can.receive && <p className="muted small" style={{ marginTop: 0 }}>Count what arrived. Good stock goes into the bin you choose; damaged stock goes to the DAMAGED area automatically.</p>}
        <div className="table-wrap"><table className="t">
          <thead><tr><th>SKU</th><th className="num">Expected</th><th className="num">Good</th><th className="num">Damaged</th><th>Batch</th><th>Expiry</th><th>Bin</th></tr></thead>
          <tbody>{d.lines.map((l: any) => {
            const r = rx[l.id] ?? {};
            const diff = l.received_qty !== null && Number(l.received_qty) + Number(l.damaged_qty ?? 0) !== Number(l.expected_qty);
            return <tr key={l.id}>
              <td><b>{l.sku_code}</b><div className="muted small">{l.sku_name} · {l.uom}</div></td>
              <td className="num">{qtyFmt(l.expected_qty)}</td>
              {d.can.receive ? <>
                <td className="num"><input style={{ width: 80, textAlign: 'right' }} value={r.received_qty ?? ''} onChange={(e) => set(l.id, 'received_qty', e.target.value)} inputMode="decimal" /></td>
                <td className="num"><input style={{ width: 70, textAlign: 'right' }} value={r.damaged_qty ?? ''} onChange={(e) => set(l.id, 'damaged_qty', e.target.value)} inputMode="decimal" /></td>
                <td><input style={{ width: 110 }} value={r.batch_no ?? ''} onChange={(e) => set(l.id, 'batch_no', e.target.value)} placeholder={l.track_batch ? 'required' : ''} /></td>
                <td><input type="date" style={{ width: 150 }} value={r.expiry_date ?? ''} onChange={(e) => set(l.id, 'expiry_date', e.target.value)} /></td>
                <td><select value={r.location_id ?? ''} onChange={(e) => set(l.id, 'location_id', e.target.value)}><option value="">Choose bin</option>
                  {bins.map((b: any) => <option key={b.id} value={b.id}>{b.code}</option>)}</select></td>
              </> : <>
                <td className="num">{qtyFmt(l.received_qty)}</td><td className="num">{Number(l.damaged_qty) ? qtyFmt(l.damaged_qty) : '—'}</td>
                <td>{l.batch_no ?? '—'}</td><td>{fmtDate(l.expiry_date)}</td><td>{l.location_code ?? '—'}{diff && <div className="flag">Differs</div>}</td>
              </>}
            </tr>; })}</tbody></table></div>
        {d.can.receive && <div className="form-actions"><button className="btn primary" onClick={() => act({ action: 'receive', lines: d.lines.map((l: any) => ({ id: l.id, ...rx[l.id] })) }, 'Goods received into stock')}>Confirm receipt</button></div>}
      </div>
      <div className="panel"><h2>History</h2>{d.events.map((e: any, i: number) => <div key={i} className="small" style={{ padding: '4px 0' }}>
        <b>{e.title}</b>{e.details && <>: {e.details}</>} <span className="muted">· {fmtDateTime(e.at)} · {e.user_name}</span></div>)}</div>
    </div>
  );
}
