'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime } from '@/components/api';
import { useMe } from '@/components/Shell';
import { ORDER_STATUS, WhTabs, qtyFmt } from '@/components/WarehouseShared';

export default function Orders() {
  const { can, lk } = useMe();
  const [f, setF] = useState<Record<string, string>>({ status: 'open' });
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { const t = setTimeout(() => api(`/api/warehouse/orders?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`)
    .then(setRows).catch((e) => setErr(e.message)), 200); return () => clearTimeout(t); }, [f]);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="page">
      <div className="page-head"><h1>Warehouse</h1><span className="spacer" />
        {(can('warehouse.orders.create') || can('warehouse.dispatch')) && <Link className="btn primary" href="/warehouse/orders/new">New outbound order</Link>}</div>
      <WhTabs />
      <div className="panel" style={{ marginBottom: 12 }}><div className="grid g4">
        <label className="f"><span>Search</span><input value={f.q ?? ''} onChange={set('q')} placeholder="Order no., customer ref., ship to" /></label>
        <label className="f"><span>Customer</span><select value={f.customer_id ?? ''} onChange={set('customer_id')}><option value="">All</option>
          {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="f"><span>Status</span><select value={f.status ?? ''} onChange={set('status')}><option value="">All</option><option value="open">Not dispatched yet</option>
          {Object.entries(ORDER_STATUS).map(([c, [n]]) => <option key={c} value={c}>{n}</option>)}</select></label>
      </div></div>
      {err && <div className="msg err">{err}</div>}
      <div className="panel flush"><div className="table-wrap"><table className="t">
        <thead><tr><th>Order</th><th>Customer</th><th>Customer ref.</th><th>Ship to</th><th>Required</th><th className="num">Qty</th><th className="num">Reserved</th><th>Dispatched</th><th>Status</th></tr></thead>
        <tbody>{rows?.map((o) => <tr key={o.id}>
          <td><Link href={`/warehouse/orders/${o.id}`}><b>{o.order_no}</b></Link><div className="muted small">{o.warehouse_code}</div></td>
          <td>{o.customer_name}</td><td>{o.customer_reference ?? '—'}</td><td>{o.ship_to_name}</td><td>{fmtDate(o.required_date)}</td>
          <td className="num">{qtyFmt(o.qty)}</td><td className="num">{o.status === 'dispatched' ? '—' : qtyFmt(o.reserved)}{o.status !== 'dispatched' && o.status !== 'cancelled' && Number(o.reserved) < Number(o.qty) && <div className="flag">Short</div>}</td>
          <td>{fmtDateTime(o.dispatched_at)}</td>
          <td><span className="badge" style={{ background: ORDER_STATUS[o.status][1] }}>{ORDER_STATUS[o.status][0]}</span></td></tr>)}
          {rows && rows.length === 0 && <tr><td colSpan={9} className="muted" style={{ padding: 24, textAlign: 'center' }}>No orders here.</td></tr>}</tbody>
      </table></div></div>
    </div>
  );
}
