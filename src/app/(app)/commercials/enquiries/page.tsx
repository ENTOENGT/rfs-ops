'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime } from '@/components/api';
import { useMe } from '@/components/Shell';
import { DataTable, Col } from '@/components/DataTable';
import { DIVISIONS, STAGES } from '@/lib/commercialRules';
import { MODES } from '@/lib/jobfileRules';

const VIEW_NAME: Record<string, string> = {
  c_all: 'All enquiries', c_open: 'Open enquiries', c_enquiry: 'New enquiries', c_rates: 'Pending agent rates', c_quoting: 'Rates in — compare and quote',
  c_approval: 'Quotations pending approval', c_sent: 'Quotations with customers', c_confirmed: 'Customer confirmed — to book', c_booking: 'Booking confirmation pending',
  c_prealert: 'Awaiting pre-alert', c_prealert_received: 'Pre-alert to verify', c_awaiting_job: 'Awaiting operational job creation',
  c_handed_over: 'Handed over to Operations', c_lost: 'Lost / cancelled',
  c_pending_quotes: 'Quotations to prepare', c_active: 'Active shipments', c_vessel_pending: 'Vessel details pending',
  c_bl_customer: 'BL drafts with customers', c_bl_correction: 'BL drafts being corrected', c_cust_pending: 'Waiting for customer confirmation',
};
// what the columns "Rate", "Quotation" and "Customer" say, from the stage
const order = STAGES.map((s) => s[0]);
const at = (stage: string, s: string) => order.indexOf(stage) >= order.indexOf(s);
const rateStatus = (st: string) => st === 'enquiry' ? 'Not requested' : st === 'rates_requested' ? 'Requested' : ['lost', 'cancelled'].includes(st) ? '—' : 'Received';
const quoteStatus = (st: string) => !at(st, 'quotation_draft') || ['lost', 'cancelled'].includes(st) ? '—' : st === 'quotation_draft' ? 'Draft'
  : st === 'pending_approval' ? 'Pending approval' : st === 'sent_to_customer' ? 'Sent' : 'Confirmed';
const custStatus = (st: string) => st === 'lost' ? 'Lost' : st === 'cancelled' ? 'Cancelled' : st === 'sent_to_customer' ? 'Waiting' : at(st, 'customer_confirmed') ? 'Confirmed' : '—';

function Register() {
  const { lk, can } = useMe();
  const sp = useSearchParams();
  const fromUrl = () => ({ view: sp.get('view') ?? 'c_all', division: sp.get('division') ?? '', mine: sp.get('mine') ?? '', assigned: sp.get('assigned') ?? '',
    salesman_id: sp.get('salesman_id') ?? '', coordinator_id: sp.get('coordinator_id') ?? '', page: '1', sort: 'updated', dir: 'desc' });
  const [f, setF] = useState<Record<string, string>>(fromUrl);
  useEffect(() => { setF(fromUrl()); }, [sp]);   // eslint-disable-line react-hooks/exhaustive-deps
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const query = (extra: Record<string, string> = {}) => new URLSearchParams(Object.entries({ ...f, ...extra }).filter(([, v]) => v)).toString();
  useEffect(() => {
    const t = setTimeout(() => api(`/api/job-files?${query()}`).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message)), 200);
    return () => clearTimeout(t);
  }, [f]);  // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value, page: '1' });
  const exportAll = async () => {
    const out: any[] = [];
    for (let p = 1; p <= 50; p++) {
      const d = await api(`/api/job-files?${query({ page: String(p), page_size: '200' })}`);
      out.push(...d.rows);
      if (out.length >= d.total || !d.rows.length) break;
    }
    return out;
  };
  const cols: Col<any>[] = [
    { key: 'enquiry_ref', label: 'Enquiry Ref', sort: 'enquiry_ref', always: true, width: 120,
      render: (r) => <Link href={`/job-files/${r.id}`} style={{ whiteSpace: 'nowrap' }}><b>{r.enquiry_ref ?? '—'}</b></Link> },
    { key: 'created_at', label: 'Enquiry date', sort: 'created', text: (r) => fmtDate(r.created_at), width: 100 },
    { key: 'division_name', label: 'Division', sort: 'division', hidden: true },
    { key: 'customer_name', label: 'Customer', sort: 'customer', width: 160 },
    { key: 'salesman_name', label: 'Salesman', sort: 'salesman' },
    { key: 'coordinator_name', label: 'Coordinator', sort: 'coordinator' },
    { key: 'mode_name', label: 'Mode', text: (r) => r.mode_name },
    { key: 'route', label: 'Route', sort: 'origin', text: (r) => [r.port_of_loading ?? r.origin, r.port_of_discharge ?? r.destination].filter(Boolean).join(' → ') },
    { key: 'rate_status', label: 'Rates', hidden: true, text: (r) => rateStatus(r.stage) },
    { key: 'quote_status', label: 'Quotation', hidden: true, text: (r) => quoteStatus(r.stage) },
    { key: 'customer_status', label: 'Customer response', hidden: true, text: (r) => custStatus(r.stage) },
    { key: 'stage_name', label: 'Stage', sort: 'stage', render: (r) => <span className="badge" style={{ background: r.stage_color }}>{r.stage_name}</span> },
    { key: 'next_action', label: 'Next action', width: 200 },
    { key: 'updated_at', label: 'Last updated', sort: 'updated', text: (r) => fmtDateTime(r.updated_at) },
    { key: 'shipping_ref', label: 'Shipping Ref', hidden: true },
    { key: 'job_no', label: 'Job No.', hidden: true },
    { key: 'etd', label: 'ETD', sort: 'etd', hidden: true, text: (r) => fmtDate(r.etd) },
    { key: 'eta', label: 'ETA', sort: 'eta', hidden: true, text: (r) => fmtDate(r.eta) },
    { key: 'created_by_name', label: 'Created by', hidden: true },
  ];
  const title = f.mine ? 'My enquiries' : f.assigned ? 'Assigned to me' : VIEW_NAME[f.view] ?? 'Enquiries';
  return (
    <div className="page">
      <div className="page-head"><h1>{title}</h1><span className="spacer" />
        {can('jobfiles.create') && <Link className="btn primary" href="/job-files/new">New enquiry</Link>}</div>
      <div className="panel" style={{ marginBottom: 12 }}><div className="grid g4">
        <label className="f"><span>Search</span><input value={f.q ?? ''} onChange={set('q')} placeholder="Enquiry / Shipping Ref, Job No., customer, port…" /></label>
        <label className="f"><span>Show</span><select value={f.view} onChange={set('view')}>
          {Object.entries(VIEW_NAME).map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
        <label className="f"><span>Division</span><select value={f.division} onChange={set('division')}><option value="">All</option>
          {DIVISIONS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
        <label className="f"><span>Mode</span><select value={f.mode ?? ''} onChange={set('mode')}><option value="">All</option>
          {MODES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
        <label className="f"><span>Customer</span><select value={f.customer_id ?? ''} onChange={set('customer_id')}><option value="">All</option>
          {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="f"><span>Salesman</span><select value={f.salesman_id} onChange={set('salesman_id')}><option value="">All</option>
          {lk.salesmen?.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label className="f"><span>Coordinator</span><select value={f.coordinator_id} onChange={set('coordinator_id')}><option value="">All</option>
          {lk.coordinators?.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select></label>
        <label className="f"><span>Enquiry date from</span><input type="date" value={f.from ?? ''} onChange={set('from')} /></label>
        <label className="f"><span>Enquiry date to</span><input type="date" value={f.to ?? ''} onChange={set('to')} /></label>
      </div></div>
      {err && <div className="msg err">{err}</div>}
      <DataTable id="enquiries" exportName="enquiries" cols={cols} rows={data?.rows ?? null} total={data?.total ?? 0} page={Number(f.page)} pageSize={data?.page_size ?? 50}
        sort={f.sort} dir={f.dir as any} onSort={(sort, dir) => setF({ ...f, sort, dir, page: '1' })} onPage={(p) => setF({ ...f, page: String(p) })}
        exportAll={exportAll} empty="No enquiries here." />
    </div>
  );
}
export default function Page() { return <Suspense fallback={<div className="page"><p className="muted">Loading…</p></div>}><Register /></Suspense>; }
