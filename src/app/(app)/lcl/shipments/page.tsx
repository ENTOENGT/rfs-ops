'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, fmtDate } from '@/components/api';
import { DataTable, Col } from '@/components/DataTable';
import { OWNER_TYPES, receivingColor } from '@/lib/lclRules';

const VIEWS: [string, string, string][] = [['all', 'All house shipments', 'House shipment register'], ['hbl', 'With a House BL', 'House BL register'],
  ['pending_receiving', 'Cargo still to receive', 'Cargo receiving'], ['to_verify', 'Received — to verify', 'Cargo to verify'],
  ['discrepancy', 'Received with differences', 'Cargo with differences'], ['undelivered', 'Arrived, not delivered', 'Arrived, not delivered']];

function Shipments() {
  const sp = useSearchParams();
  const fromUrl = () => ({ view: sp.get('view') ?? 'all', page: '1' });
  const [f, setF] = useState<Record<string, string>>(fromUrl);
  useEffect(() => { setF(fromUrl()); }, [sp]);  // eslint-disable-line react-hooks/exhaustive-deps
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const query = (extra: Record<string, string> = {}) => new URLSearchParams(Object.entries({ ...f, ...extra }).filter(([, v]) => v)).toString();
  useEffect(() => {
    const t = setTimeout(() => api(`/api/lcl/shipments?${query()}`).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message)), 200);
    return () => clearTimeout(t);
  }, [f]);  // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value, page: '1' });
  const exportAll = async () => {
    const out: any[] = [];
    for (let p = 1; p <= 50; p++) { const d = await api(`/api/lcl/shipments?${query({ page: String(p), page_size: '200' })}`); out.push(...d.rows); if (out.length >= d.total || !d.rows.length) break; }
    return out;
  };
  const cols: Col<any>[] = [
    { key: 'hbl_no', label: 'House BL', always: true, render: (r) => <b>{r.hbl_no ?? <span className="muted">not yet</span>}</b> },
    { key: 'con_ref', label: 'Consolidation', render: (r) => <Link href={`/lcl/${r.consolidation_id}`}>{r.con_ref}</Link> },
    { key: 'mbl_no', label: 'Master BL' }, { key: 'container_no', label: 'Container' },
    { key: 'owner_name', label: 'Cargo owner', text: (r) => `${r.owner_name ?? ''} (${r.owner_type_name})` },
    { key: 'shipper', label: 'Shipper', hidden: true }, { key: 'consignee', label: 'Consignee' },
    { key: 'salesman_name', label: 'Salesman', hidden: true }, { key: 'coordinator_name', label: 'Coordinator', hidden: true },
    { key: 'shipment', label: 'Shipment', text: (r) => r.job_no ?? r.shipping_ref ?? r.enquiry_ref ?? '',
      render: (r) => r.job_file_id ? <Link href={`/job-files/${r.job_file_id}`}>{r.job_no ?? r.shipping_ref ?? r.enquiry_ref}</Link> : '—' },
    { key: 'packages', label: 'Pkgs', num: true }, { key: 'received_packages', label: 'Received', num: true },
    { key: 'outstanding_packages', label: 'Outstanding', num: true, hidden: f.view !== 'pending_receiving' },
    { key: 'gross_weight_kg', label: 'Kg', num: true, hidden: true }, { key: 'volume_cbm', label: 'CBM', num: true },
    { key: 'expected_arrival', label: 'Cargo expected', text: (r) => fmtDate(r.expected_arrival), hidden: f.view !== 'pending_receiving' },
    { key: 'receiving_name', label: 'Receiving', render: (r) => <span className="badge" style={{ background: receivingColor(r.receiving_status) }}>{r.receiving_name}</span> },
    { key: 'stuffing_name', label: 'Stuffing' },
    { key: 'delivery_status', label: 'Delivery', text: (r) => r.delivery_status === 'delivered' ? `Delivered ${fmtDate(r.delivered_at)}` : 'Pending', hidden: true },
    { key: 'etd', label: 'ETD', text: (r) => fmtDate(r.etd) },
    { key: 'con_status_name', label: 'Container status' },
  ];
  const title = VIEWS.find(([k]) => k === f.view)?.[2] ?? 'House shipments';
  return (
    <div className="page">
      <div className="page-head"><h1>{title}</h1></div>
      <div className="panel" style={{ marginBottom: 12 }}><div className="grid g3">
        <label className="f"><span>Search</span><input value={f.q ?? ''} onChange={set('q')} placeholder="HBL, MBL, container, shipper, consignee, Job No.…" /></label>
        <label className="f"><span>Show</span><select value={f.view} onChange={set('view')}>{VIEWS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
        <label className="f"><span>Cargo owner</span><select value={f.owner_type ?? ''} onChange={set('owner_type')}><option value="">All</option>{OWNER_TYPES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
      </div></div>
      {err && <div className="msg err">{err}</div>}
      <DataTable id={`lcl-shp-${f.view}`} exportName={title.toLowerCase().replace(/\W+/g, '-')} cols={cols} rows={data?.rows ?? null} total={data?.total ?? 0} page={Number(f.page)}
        pageSize={data?.page_size ?? 50} onPage={(p) => setF({ ...f, page: String(p) })} exportAll={exportAll} empty="Nothing here." />
    </div>
  );
}
export default function Page() { return <Suspense fallback={<div className="page"><p className="muted">Loading…</p></div>}><Shipments /></Suspense>; }
