'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, fmtDate, fmtMoney } from '@/components/api';
import { useMe } from '@/components/Shell';
import { NewVendorRequest } from '@/components/NewVendorRequest';

import { RATE_SOURCES } from '@/lib/commercialRules';

export default function Page() { return <Suspense fallback={<div className="page"><p className="muted">Loading…</p></div>}><VendorRequests /></Suspense>; }
function VendorRequests() {
  const { me, can, lk } = useMe();
  const router = useRouter();
  const sp = useSearchParams();
  const fromUrl = () => ({ status: sp.get('status') ?? 'open', service: sp.get('service') ?? '', rate_source: sp.get('rate_source') ?? '', mine: sp.get('mine') ?? '' });
  const [f, setF] = useState<Record<string, string>>(fromUrl);
  useEffect(() => { setF(fromUrl()); }, [sp]);  // eslint-disable-line react-hooks/exhaustive-deps
  const [rows, setRows] = useState<any[] | null>(null);
  const [nw, setNw] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => { const t = setTimeout(() => api(`/api/vendor-requests?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`).then(setRows).catch((e) => setErr(e.message)), 200); return () => clearTimeout(t); }, [f]);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const cost = me.financial_access.buyingView;
  return (
    <div className="page">
      <div className="page-head"><h1>{f.service === 'rate' ? (RATE_SOURCES.find(([k]) => k === f.rate_source)?.[1] ?? 'Rate') + ' requests' : f.service === 'booking' ? 'Booking requests' : f.mine === 'assigned' ? 'Assigned to me' : 'Vendor requests'}</h1><span className="spacer" />
        {can('vendors.manage') && <Link className="btn" href="/vendors">Vendors</Link>}
        {can('vendors.requests') && <button className="btn primary" onClick={() => setNw(true)}>New request</button>}</div>
      <p className="muted small" style={{ marginTop: -6 }}>Bookings and services with shipping lines, airlines, agents, brokers and transporters. Bills and payments stay in the ERP.</p>
      <div className="panel" style={{ marginBottom: 12 }}><div className="grid g4">
        <label className="f"><span>Search</span><input value={f.q ?? ''} onChange={set('q')} placeholder="VR no., vendor, Job No., vendor ref." /></label>
        <label className="f"><span>Vendor</span><select value={f.vendor_id ?? ''} onChange={set('vendor_id')}><option value="">All</option>
          {lk.vendors?.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
        <label className="f"><span>Service</span><select value={f.service} onChange={set('service')}><option value="">All</option>
          <option value="rate">Rate requests</option><option value="booking">Bookings</option><option value="trucking">Trucking</option><option value="customs">Customs</option>
          <option value="warehousing">Warehousing</option><option value="courier">Courier</option><option value="documentation">Documentation</option><option value="other">Other</option></select></label>
        <label className="f"><span>Rate source</span><select value={f.rate_source} onChange={set('rate_source')}><option value="">All</option>
          {RATE_SOURCES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
        <label className="f"><span>Status</span><select value={f.status ?? ''} onChange={set('status')}><option value="">All</option><option value="open">Not finished</option>
          <option value="requested">Waiting for rate / reply</option><option value="quoted">Rate received</option><option value="completed">Completed</option><option value="disputed">Disputed</option><option value="cancelled">Cancelled</option></select></label>
      </div></div>
      {err && <div className="msg err">{err}</div>}
      <div className="panel flush"><div className="table-wrap"><table className="t">
        <thead><tr><th>Request</th><th>Vendor</th><th>Service</th><th>Shipment</th><th>Needed by</th><th>Vendor ref.</th>{cost && <th className="num">Cost</th>}<th>Status</th></tr></thead>
        <tbody>{rows?.map((r) => <tr key={r.id}><td><Link href={`/vendor-requests/${r.id}`}><b>{r.request_no}</b></Link><div className="muted small">{r.description.slice(0, 60)}</div></td>
          <td>{r.vendor_name}{r.rate_group && <div className="muted small">Compared with other vendors</div>}</td><td className="small">{r.service_name}</td><td>{r.job_file_id ? <Link href={`/job-files/${r.job_file_id}`}>{r.job_no ?? r.shipping_ref ?? r.enquiry_ref}</Link> : '—'}{r.assigned_to_name && <div className="muted small">via {r.assigned_to_name}</div>}</td>
          <td>{fmtDate(r.needed_by)}{r.late && <div className="flag">Late</div>}</td><td>{r.vendor_reference ?? '—'}</td>
          {cost && <td className="num">{r.quoted_cost ? fmtMoney(r.quoted_cost, r.currency) : '—'}</td>}
          <td><span className="badge" style={{ background: r.status_color }}>{r.status_name}</span></td></tr>)}
          {rows && rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ padding: 24, textAlign: 'center' }}>No requests here.</td></tr>}</tbody></table></div></div>
      {nw && <NewVendorRequest onClose={() => setNw(null)} onDone={(r) => router.push(`/vendor-requests/${r.id}`)} />}
    </div>
  );
}
