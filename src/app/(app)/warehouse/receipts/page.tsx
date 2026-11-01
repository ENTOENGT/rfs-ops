'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime } from '@/components/api';
import { useMe } from '@/components/Shell';
import { GRN_STATUS, WhTabs, qtyFmt } from '@/components/WarehouseShared';

export default function Receipts() {
  const { can, lk } = useMe();
  const [f, setF] = useState<Record<string, string>>({ status: 'expected' });
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { const t = setTimeout(() => api(`/api/warehouse/receipts?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`)
    .then(setRows).catch((e) => setErr(e.message)), 200); return () => clearTimeout(t); }, [f]);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="page">
      <div className="page-head"><h1>Warehouse</h1><span className="spacer" />
        {(can('warehouse.receive') || can('warehouse.configure')) && <Link className="btn primary" href="/warehouse/receipts/new">New receipt</Link>}</div>
      <WhTabs />
      <div className="panel" style={{ marginBottom: 12 }}><div className="grid g4">
        <label className="f"><span>Search</span><input value={f.q ?? ''} onChange={set('q')} placeholder="GRN, reference, supplier, Job No." /></label>
        <label className="f"><span>Customer</span><select value={f.customer_id ?? ''} onChange={set('customer_id')}><option value="">All</option>
          {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="f"><span>Status</span><select value={f.status ?? ''} onChange={set('status')}><option value="">All</option>
          {Object.entries(GRN_STATUS).map(([c, [n]]) => <option key={c} value={c}>{n}</option>)}</select></label>
      </div></div>
      {err && <div className="msg err">{err}</div>}
      <div className="panel flush"><div className="table-wrap"><table className="t">
        <thead><tr><th>GRN</th><th>Customer</th><th>Warehouse</th><th>Job No.</th><th>Reference</th><th>Expected</th><th>Received</th><th className="num">Qty expected</th><th className="num">Qty in</th><th>Status</th></tr></thead>
        <tbody>{rows?.map((g) => <tr key={g.id}>
          <td><Link href={`/warehouse/receipts/${g.id}`}><b>{g.grn_no}</b></Link></td><td>{g.customer_name}</td><td>{g.warehouse_code}</td><td>{g.job_no ?? '—'}</td>
          <td className="small">{[g.supplier, g.reference].filter(Boolean).join(' · ') || '—'}</td><td>{fmtDate(g.expected_date)}</td><td>{fmtDateTime(g.received_at)}</td>
          <td className="num">{qtyFmt(g.expected_qty)}</td><td className="num">{g.status === 'received' ? qtyFmt(g.received_qty) : '—'}</td>
          <td><span className="badge" style={{ background: GRN_STATUS[g.status][1] }}>{GRN_STATUS[g.status][0]}</span></td></tr>)}
          {rows && rows.length === 0 && <tr><td colSpan={10} className="muted" style={{ padding: 24, textAlign: 'center' }}>No receipts here.</td></tr>}</tbody>
      </table></div></div>
    </div>
  );
}
