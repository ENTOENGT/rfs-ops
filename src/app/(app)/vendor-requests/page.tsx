'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtMoney } from '@/components/api';
import { useMe } from '@/components/Shell';

const SERVICES: [string, string][] = [['booking', 'Freight booking'], ['trucking', 'Trucking'], ['customs', 'Customs brokerage'], ['warehousing', 'Warehousing'],
  ['courier', 'Courier'], ['documentation', 'Documentation'], ['other', 'Other']];

export default function VendorRequests() {
  const { me, can, lk } = useMe();
  const router = useRouter();
  const [f, setF] = useState<Record<string, string>>({ status: 'open' });
  const [rows, setRows] = useState<any[] | null>(null);
  const [nw, setNw] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => { const t = setTimeout(() => api(`/api/vendor-requests?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`).then(setRows).catch((e) => setErr(e.message)), 200); return () => clearTimeout(t); }, [f]);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const cost = me.financial_access.buyingView;
  const create = async () => { setErr(''); try { const r = await api('/api/vendor-requests', { body: nw }); router.push(`/vendor-requests/${r.id}`); } catch (e: any) { setErr(e.message); } };
  return (
    <div className="page">
      <div className="page-head"><h1>Vendor requests</h1><span className="spacer" />
        {can('vendors.manage') && <Link className="btn" href="/vendors">Vendors</Link>}
        {can('vendors.requests') && <button className="btn primary" onClick={() => setNw({ service: 'booking' })}>New request</button>}</div>
      <p className="muted small" style={{ marginTop: -6 }}>Bookings and services with shipping lines, airlines, agents, brokers and transporters. Bills and payments stay in the ERP.</p>
      <div className="panel" style={{ marginBottom: 12 }}><div className="grid g4">
        <label className="f"><span>Search</span><input value={f.q ?? ''} onChange={set('q')} placeholder="VR no., vendor, Job No., vendor ref." /></label>
        <label className="f"><span>Vendor</span><select value={f.vendor_id ?? ''} onChange={set('vendor_id')}><option value="">All</option>
          {lk.vendors?.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
        <label className="f"><span>Status</span><select value={f.status ?? ''} onChange={set('status')}><option value="">All</option><option value="open">Not finished</option>
          <option value="completed">Completed</option><option value="disputed">Disputed</option><option value="cancelled">Cancelled</option></select></label>
      </div></div>
      {err && <div className="msg err">{err}</div>}
      <div className="panel flush"><div className="table-wrap"><table className="t">
        <thead><tr><th>Request</th><th>Vendor</th><th>Service</th><th>Job No.</th><th>Needed by</th><th>Vendor ref.</th>{cost && <th className="num">Cost</th>}<th>Status</th></tr></thead>
        <tbody>{rows?.map((r) => <tr key={r.id}><td><Link href={`/vendor-requests/${r.id}`}><b>{r.request_no}</b></Link><div className="muted small">{r.description.slice(0, 60)}</div></td>
          <td>{r.vendor_name}</td><td className="small">{r.service_name}</td><td>{r.job_no ?? '—'}</td>
          <td>{fmtDate(r.needed_by)}{r.late && <div className="flag">Late</div>}</td><td>{r.vendor_reference ?? '—'}</td>
          {cost && <td className="num">{r.quoted_cost ? fmtMoney(r.quoted_cost, r.currency) : '—'}</td>}
          <td><span className="badge" style={{ background: r.status_color }}>{r.status_name}</span></td></tr>)}
          {rows && rows.length === 0 && <tr><td colSpan={8} className="muted" style={{ padding: 24, textAlign: 'center' }}>No requests here.</td></tr>}</tbody></table></div></div>
      {nw && <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setNw(null)}><div className="modal" role="dialog" aria-label="New vendor request">
        <h2>New vendor request</h2>
        {err && <div className="msg err">{err}</div>}
        {(lk.vendors ?? []).length === 0 && <div className="msg warn">No vendors yet — add them under Vendors first.</div>}
        <div className="grid g2">
          <label className="f"><span>Vendor <em>*</em></span><select value={nw.vendor_id ?? ''} onChange={(e) => setNw({ ...nw, vendor_id: e.target.value })}><option value="">Choose vendor</option>
            {lk.vendors?.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
          <label className="f"><span>Service <em>*</em></span><select value={nw.service} onChange={(e) => setNw({ ...nw, service: e.target.value })}>{SERVICES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>
          <label className="f"><span>Job No.</span><input value={nw.job_no ?? ''} onChange={(e) => setNw({ ...nw, job_no: e.target.value })} /></label>
          <label className="f"><span>Needed by</span><input type="date" value={nw.needed_by ?? ''} onChange={(e) => setNw({ ...nw, needed_by: e.target.value })} /></label>
          {cost && <label className="f"><span>Vendor price (if known)</span><input value={nw.quoted_cost ?? ''} onChange={(e) => setNw({ ...nw, quoted_cost: e.target.value })} inputMode="decimal" /></label>}
          <label className="f span2"><span>What the vendor must do <em>*</em></span><textarea rows={3} value={nw.description ?? ''} onChange={(e) => setNw({ ...nw, description: e.target.value })} /></label>
        </div>
        <div className="actions"><button className="btn" onClick={() => setNw(null)}>Cancel</button><button className="btn primary" onClick={create}>Create request</button></div>
      </div></div>}
    </div>
  );
}
