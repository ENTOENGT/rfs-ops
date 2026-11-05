'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, fmtDate, fmtMoney } from '@/components/api';
import { useMe } from '@/components/Shell';
import { DataTable, Col } from '@/components/DataTable';
import { Q_STATUSES, SERVICE_TYPES } from '@/lib/jobfileRules';

const TITLES: Record<string, string> = { draft: 'Draft quotations', pending_approval: 'Quotations pending approval', approved: 'Approved quotations',
  sent: 'Quotations sent to customers', confirmed: 'Customer confirmed', closed_out: 'Rejected / expired quotations', open: 'Open quotations', '': 'All quotations' };

function Quotations() {
  const { me, can, lk } = useMe();
  const sp = useSearchParams();
  const fromUrl = () => ({ status: sp.get('status') ?? 'open', my_approval: sp.get('my_approval') ?? '', page: '1' });
  const [f, setF] = useState<Record<string, string>>(fromUrl);
  useEffect(() => { setF(fromUrl()); }, [sp]);  // eslint-disable-line react-hooks/exhaustive-deps
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const query = (extra: Record<string, string> = {}) => new URLSearchParams(Object.entries({ ...f, ...extra }).filter(([, v]) => v)).toString();
  useEffect(() => {
    const t = setTimeout(() => api(`/api/quotations?${query()}`).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message)), 200);
    return () => clearTimeout(t);
  }, [f]);  // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value, page: '1' });
  const { sellingView, profitView } = me.financial_access;
  const exportAll = async () => {
    const out: any[] = [];
    for (let p = 1; p <= 50; p++) { const d = await api(`/api/quotations?${query({ page: String(p), page_size: '200' })}`); out.push(...d.rows); if (out.length >= d.total || !d.rows.length) break; }
    return out;
  };
  const cols: Col<any>[] = [
    { key: 'quote_no', label: 'Quote', always: true, render: (r) => <><Link href={`/quotations/${r.id}`}><b>{r.quote_no}</b></Link>{r.version_no > 1 && <span className="muted"> v{r.version_no}</span>}
      {r.loss && <span className="loss-tag">LOSS</span>}</>, text: (r) => `${r.quote_no}${r.version_no > 1 ? ` v${r.version_no}` : ''}${r.loss ? ' (LOSS)' : ''}` },
    { key: 'created_at', label: 'Date', text: (r) => fmtDate(r.created_at) },
    { key: 'customer_name', label: 'Customer', width: 160 },
    { key: 'service_name', label: 'Service' },
    { key: 'route', label: 'Route', text: (r) => [r.origin, r.destination].filter(Boolean).join(' → ') },
    { key: 'valid_until', label: 'Valid until', text: (r) => fmtDate(r.valid_until) },
    ...(sellingView ? [{ key: 'sell_total', label: 'Total', num: true, text: (r: any) => r.totals.sell_total, render: (r: any) => fmtMoney(r.totals.sell_total, r.currency) }] : []),
    ...(profitView ? [{ key: 'margin_pct', label: 'Margin', num: true, text: (r: any) => r.totals.margin_pct, render: (r: any) => r.totals.margin_pct === null ? '—' : `${r.totals.margin_pct}%` }] : []),
    { key: 'salesman_name', label: 'Salesman' },
    { key: 'created_by_name', label: 'Prepared by' },
    { key: 'shipment', label: 'Shipment', text: (r) => r.job_no ?? r.shipping_ref ?? r.enquiry_ref ?? '',
      render: (r) => r.job_file_id ? <Link href={`/job-files/${r.job_file_id}`}>{r.job_no ?? r.shipping_ref ?? r.enquiry_ref}</Link> : '—' },
    { key: 'status_name', label: 'Status', render: (r) => <span className="badge" style={{ background: r.status_color }}>{r.status_name}</span> },
  ];
  return (
    <div className="page">
      <div className="page-head"><h1>{f.my_approval ? 'Waiting for my approval' : TITLES[f.status] ?? 'Quotations'}</h1><span className="spacer" />
        {can('quotes.create') && <Link className="btn primary" href="/quotations/new">New quotation</Link>}</div>
      <p className="muted small" style={{ marginTop: -6 }}>Commercial rates — never shown to Transport, Messenger, PRO or Warehouse staff. Rows in red sell below cost. Invoicing stays in the ERP.</p>
      <div className="panel" style={{ margin: '12px 0' }}><div className="grid g4">
        <label className="f"><span>Search</span><input value={f.q ?? ''} onChange={set('q')} placeholder="Quote no., customer, route…" /></label>
        <label className="f"><span>Customer</span><select value={f.customer_id ?? ''} onChange={set('customer_id')}><option value="">All</option>
          {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="f"><span>Service</span><select value={f.service_type ?? ''} onChange={set('service_type')}><option value="">All</option>
          {SERVICE_TYPES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>
        <label className="f"><span>Status</span><select value={f.status ?? ''} onChange={set('status')}><option value="">All</option>
          <option value="open">Open (not decided yet)</option><option value="confirmed">Customer confirmed</option><option value="closed_out">Rejected / expired</option>
          {Q_STATUSES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>
      </div></div>
      {err && <div className="msg err">{err}</div>}
      <DataTable id="quotations" exportName="quotations" cols={cols} rows={data?.rows ?? null} total={data?.total ?? 0} page={Number(f.page)} pageSize={data?.page_size ?? 50}
        onPage={(p) => setF({ ...f, page: String(p) })} exportAll={exportAll} rowClass={(r) => r.loss ? 'loss' : ''} empty="No quotations here." />
    </div>
  );
}
export default function Page() { return <Suspense fallback={<div className="page"><p className="muted">Loading…</p></div>}><Quotations /></Suspense>; }
