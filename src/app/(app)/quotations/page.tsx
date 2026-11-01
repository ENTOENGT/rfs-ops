'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtMoney } from '@/components/api';
import { useMe } from '@/components/Shell';
import { Q_STATUSES, SERVICE_TYPES } from '@/lib/jobfileRules';

export default function Quotations() {
  const { me, can, lk } = useMe();
  const [f, setF] = useState<Record<string, string>>({ status: 'open', page: '1' });
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const t = setTimeout(() => api(`/api/quotations?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`)
      .then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message)), 200);
    return () => clearTimeout(t);
  }, [f]);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value, page: '1' });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const { sellingView, profitView } = me.financial_access;
  return (
    <div className="page">
      <div className="page-head"><h1>Quotations</h1><span className="spacer" />
        {can('quotes.create') && <Link className="btn primary" href="/quotations/new">New quotation</Link>}</div>
      <p className="muted small" style={{ marginTop: -6 }}>Commercial rates — never shown to Transport, Messenger, PRO or Warehouse staff. An accepted quotation becomes a Job File. Invoicing stays in the ERP.</p>
      <div className="panel" style={{ margin: '12px 0' }}><div className="grid g4">
        <label className="f"><span>Search</span><input value={f.q ?? ''} onChange={set('q')} placeholder="Quote no., customer, route…" /></label>
        <label className="f"><span>Customer</span><select value={f.customer_id ?? ''} onChange={set('customer_id')}><option value="">All</option>
          {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="f"><span>Service</span><select value={f.service_type ?? ''} onChange={set('service_type')}><option value="">All</option>
          {SERVICE_TYPES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>
        <label className="f"><span>Status</span><select value={f.status ?? ''} onChange={set('status')}><option value="">All</option>
          <option value="open">Open (not decided yet)</option>{Q_STATUSES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>
      </div></div>
      {err && <div className="msg err">{err}</div>}
      <div className="panel flush"><div className="table-wrap"><table className="t">
        <thead><tr><th>Quote</th><th>Customer</th><th>Service</th><th>Route</th><th>Valid until</th>
          {sellingView && <th className="num">Total</th>}{profitView && <th className="num">Margin</th>}<th>Job File</th><th>Status</th></tr></thead>
        <tbody>
          {data?.rows.map((r: any) => <tr key={r.id}>
            <td><Link href={`/quotations/${r.id}`}><b>{r.quote_no}</b></Link><div className="muted small">{r.created_by_name}</div></td>
            <td>{r.customer_name}</td><td className="small">{r.service_name}</td>
            <td className="small">{[r.origin, r.destination].filter(Boolean).join(' → ') || '—'}</td>
            <td>{fmtDate(r.valid_until)}</td>
            {sellingView && <td className="num">{fmtMoney(r.totals.sell_total, r.currency)}</td>}
            {profitView && <td className="num">{r.totals.margin_pct === null ? '—' : `${r.totals.margin_pct}%`}</td>}
            <td>{r.job_file_id ? <Link href={`/job-files/${r.job_file_id}`}>{r.job_no}</Link> : '—'}</td>
            <td><span className="badge" style={{ background: r.status_color }}>{r.status_name}</span></td>
          </tr>)}
          {data && data.rows.length === 0 && <tr><td colSpan={9} className="muted" style={{ padding: 24, textAlign: 'center' }}>No quotations here.</td></tr>}
        </tbody></table></div>
        <div className="pager"><span>{data ? `${data.total} quotation${data.total === 1 ? '' : 's'}` : 'Loading…'}</span><span className="spacer" />
          <button className="btn small" disabled={f.page === '1'} onClick={() => setF({ ...f, page: String(Number(f.page) - 1) })}>Previous</button>
          <span>Page {f.page} of {pages}</span>
          <button className="btn small" disabled={Number(f.page) >= pages} onClick={() => setF({ ...f, page: String(Number(f.page) + 1) })}>Next</button></div>
      </div>
    </div>
  );
}
