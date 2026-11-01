'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime } from '@/components/api';
import { ORDER_STATUS, WhTabs, qtyFmt } from '@/components/WarehouseShared';

export default function Order({ params }: { params: { id: string } }) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState<{ m: string; short?: boolean } | null>(null);
  const [ok, setOk] = useState('');
  useEffect(() => { api(`/api/warehouse/orders/${params.id}`).then(setD).catch((e) => setErr({ m: e.message })); }, [params.id]);
  const act = async (body: any, done: string) => {
    setErr(null); setOk('');
    try { setD(await api(`/api/warehouse/orders/${params.id}`, { body })); setOk(done); }
    catch (e: any) { setErr({ m: e.message, short: e.code === 'NOT_ENOUGH_STOCK' && body.action === 'reserve' && !body.allow_partial }); window.scrollTo(0, 0); }
  };
  if (!d) return <div className="page">{err ? <div className="msg err">{err.m}</div> : <p className="muted">Loading…</p>}</div>;
  const st = ORDER_STATUS[d.status];
  return (
    <div className="page">
      <div className="page-head no-print"><h1>{d.order_no}</h1><span className="badge" style={{ background: st[1] }}>{st[0]}</span><span className="spacer" />
        {d.can.reserve && <button className="btn primary" onClick={() => act({ action: 'reserve' }, 'Stock reserved')}>Reserve stock</button>}
        {d.picks.length > 0 && !['dispatched', 'cancelled'].includes(d.status) && <button className="btn" onClick={() => window.print()}>Print pick list</button>}
        {d.can.pick && <button className="btn primary" onClick={() => act({ action: 'pick' }, 'Marked as picked')}>Picked</button>}
        {d.can.pack && <button className="btn primary" onClick={() => {
          const packages = prompt('How many packages?'); if (!packages) return;
          const weight = prompt('Gross weight in kg (optional):') ?? ''; act({ action: 'pack', packages, gross_weight_kg: weight }, 'Packed'); }}>Packed</button>}
        {d.can.dispatch && <button className="btn primary" onClick={() => {
          const ref = prompt('How did it leave? Vehicle no., courier AWB or transport request no.:'); if (ref) act({ action: 'dispatch', dispatch_reference: ref }, 'Dispatched — stock reduced'); }}>Dispatch</button>}
        {d.can.cancel && <button className="btn danger" onClick={() => { const reason = prompt('Cancel this order? Reserved stock is released. Reason:'); if (reason) act({ action: 'cancel', reason }, 'Cancelled'); }}>Cancel</button>}
      </div>
      <div className="no-print"><WhTabs /></div>
      {err && <div className="msg err no-print">{err.m} {err.short && <button className="btn small" onClick={() => act({ action: 'reserve', allow_partial: true }, 'Reserved what is available; the rest stays open')}>Yes, reserve what there is</button>}</div>}
      {ok && <div className="msg ok no-print">{ok}</div>}
      <div className="print-only"><h2 style={{ margin: '0 0 6px' }}>Pick list — {d.order_no}</h2></div>
      <div className="cols">
        <div>
          <div className="panel"><h2>Items</h2><div className="table-wrap"><table className="t">
            <thead><tr><th>SKU</th><th className="num">Ordered</th><th className="num">{d.status === 'dispatched' ? 'Sent' : 'Reserved'}</th><th className="num">Still free in stock</th></tr></thead>
            <tbody>{d.lines.map((l: any) => <tr key={l.id}><td><b>{l.sku_code}</b><div className="muted small">{l.sku_name} · {l.uom}</div></td>
              <td className="num">{qtyFmt(l.qty)}</td><td className="num">{qtyFmt(l.reserved)}{Number(l.reserved) < Number(l.qty) && d.status !== 'cancelled' && <div className="flag">Short {qtyFmt(Number(l.qty) - Number(l.reserved))}</div>}</td>
              <td className="num">{qtyFmt(l.available)}</td></tr>)}</tbody></table></div></div>
          {d.picks.length > 0 && <div className="panel"><h2>Pick list (earliest expiry first)</h2><div className="table-wrap"><table className="t">
            <thead><tr><th>Bin</th><th>SKU</th><th>Batch</th><th>Expiry</th><th className="num">Pick</th><th className="print-only">✓</th></tr></thead>
            <tbody>{d.picks.map((p: any) => <tr key={p.id}><td><b>{p.location_code}</b></td><td>{p.sku_code}</td><td>{p.batch_no || '—'}</td><td>{fmtDate(p.expiry_date)}</td>
              <td className="num"><b>{qtyFmt(p.qty)}</b></td><td className="print-only">☐</td></tr>)}</tbody></table></div></div>}
        </div>
        <div>
          <div className="panel"><h2>Order</h2><dl className="kv">
            <dt>Customer</dt><dd>{d.customer_name}</dd><dt>Customer ref.</dt><dd>{d.customer_reference ?? '—'}</dd>
            <dt>Ship to</dt><dd>{d.ship_to_name}{d.ship_to_address && <div>{d.ship_to_address}</div>}{(d.ship_to_contact || d.ship_to_phone) && <div>{[d.ship_to_contact, d.ship_to_phone].filter(Boolean).join(' · ')}</div>}</dd>
            <dt>Warehouse</dt><dd>{d.warehouse_code} — {d.warehouse_name}</dd><dt>Required</dt><dd>{fmtDate(d.required_date)}</dd>
            <dt>Job No.</dt><dd>{d.job_file_id ? <Link href={`/job-files/${d.job_file_id}`}>{d.job_no}</Link> : '—'}</dd>
            {d.packages && <><dt>Packed</dt><dd>{d.packages} package(s){d.gross_weight_kg && `, ${Number(d.gross_weight_kg)} kg`}</dd></>}
            {d.dispatch_reference && <><dt>Dispatched</dt><dd>{fmtDateTime(d.dispatched_at)} — {d.dispatch_reference}</dd></>}
            {d.cancel_reason && <><dt>Cancelled</dt><dd>{d.cancel_reason}</dd></>}
            {d.remarks && <><dt>Remarks</dt><dd>{d.remarks}</dd></>}
          </dl></div>
          <div className="panel no-print"><h2>History</h2>{d.events.map((e: any, i: number) => <div key={i} className="small" style={{ padding: '4px 0' }}>
            <b>{e.title}</b>{e.details && <>: {e.details}</>}<div className="muted">{fmtDateTime(e.at)} · {e.user_name}</div></div>)}</div>
        </div>
      </div>
    </div>
  );
}
