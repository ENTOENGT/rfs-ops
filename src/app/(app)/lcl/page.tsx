'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, fmtDate } from '@/components/api';
import { useMe } from '@/components/Shell';
import { DataTable, Col } from '@/components/DataTable';
import { DIVISIONS } from '@/lib/commercialRules';

const VIEWS: [string, string][] = [['active', 'All live'], ['receiving', 'Receiving cargo'], ['stuffing', 'Stuffing and dispatch'], ['in_transit', 'On the way (container monitoring)'],
  ['arrived', 'Arrived'], ['closed', 'Closed'], ['cancelled', 'Cancelled'], ['all', 'Everything']];

function Register() {
  const { can } = useMe();
  const sp = useSearchParams();
  const fromUrl = () => ({ view: sp.get('view') ?? 'active', page: '1', sort: 'etd', dir: 'asc' });
  const [f, setF] = useState<Record<string, string>>(fromUrl);
  useEffect(() => { setF(fromUrl()); }, [sp]);  // eslint-disable-line react-hooks/exhaustive-deps
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  const query = (extra: Record<string, string> = {}) => new URLSearchParams(Object.entries({ ...f, ...extra }).filter(([, v]) => v)).toString();
  useEffect(() => {
    const t = setTimeout(() => api(`/api/lcl?${query()}`).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message)), 200);
    return () => clearTimeout(t);
  }, [f]);  // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value, page: '1' });
  const exportAll = async () => {
    const out: any[] = [];
    for (let p = 1; p <= 50; p++) { const d = await api(`/api/lcl?${query({ page: String(p), page_size: '200' })}`); out.push(...d.rows); if (out.length >= d.total || !d.rows.length) break; }
    return out;
  };
  const cols: Col<any>[] = [
    { key: 'con_ref', label: 'Consolidation', sort: 'con_ref', always: true, render: (r) => <Link href={`/lcl/${r.id}`} style={{ whiteSpace: 'nowrap' }}><b>{r.con_ref}</b></Link> },
    { key: 'division_name', label: 'Division', hidden: true },
    { key: 'route', label: 'Route', sort: 'pod', text: (r) => [r.pol ?? r.origin, r.pod ?? r.destination].filter(Boolean).join(' → ') },
    { key: 'carrier', label: 'Carrier' },
    { key: 'carrier_booking_id', label: 'Booking ID', hidden: true },
    { key: 'container_no', label: 'Container', sort: 'container', text: (r) => r.container_no ? `${r.container_no}${r.container_type ? ` (${r.container_type})` : ''}` : (r.container_type ?? '') },
    { key: 'mbl_no', label: 'Master BL' },
    { key: 'total_hbls', label: 'HBLs', num: true },
    { key: 'total_packages', label: 'Packages', num: true, hidden: true },
    { key: 'total_weight_kg', label: 'Weight kg', num: true, hidden: true },
    { key: 'total_cbm', label: 'CBM', num: true, text: (r) => Number(r.total_cbm).toFixed(2) },
    { key: 'utilisation_pct', label: 'Used', num: true, render: (r) => r.utilisation_pct === null ? '—' : `${r.utilisation_pct}%`, text: (r) => r.utilisation_pct },
    { key: 'receiving_summary', label: 'Cargo receiving' },
    { key: 'stuffing_summary', label: 'Stuffing' },
    { key: 'etd', label: 'ETD', sort: 'etd', text: (r) => fmtDate(r.etd) },
    { key: 'eta', label: 'ETA', sort: 'eta', text: (r) => fmtDate(r.eta) },
    { key: 'status_name', label: 'Status', sort: 'status', render: (r) => <span className="badge" style={{ background: r.status_color }}>{r.status_name}</span> },
  ];
  return (
    <div className="page">
      <div className="page-head"><h1>{f.view === 'in_transit' ? 'Container monitoring' : f.view === 'stuffing' ? 'Stuffing and dispatch' : 'Consolidation register'}</h1><span className="spacer" />
        {can('lcl.manage') && <Link className="btn primary" href="/lcl/new">Create consolidation</Link>}</div>
      <div className="panel" style={{ marginBottom: 12 }}><div className="grid g4">
        <label className="f"><span>Search</span><input value={f.q ?? ''} onChange={set('q')} placeholder="CON ref, MBL, HBL, container, booking, shipper…" /></label>
        <label className="f"><span>Show</span><select value={f.view} onChange={set('view')}>{VIEWS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
        <label className="f"><span>Division</span><select value={f.division ?? ''} onChange={set('division')}><option value="">All</option>{DIVISIONS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
        <div className="grid g2" style={{ gap: 8 }}><label className="f"><span>ETD from</span><input type="date" value={f.from ?? ''} onChange={set('from')} /></label>
          <label className="f"><span>ETD to</span><input type="date" value={f.to ?? ''} onChange={set('to')} /></label></div>
      </div></div>
      {err && <div className="msg err">{err}</div>}
      <DataTable id="lcl" exportName="consolidations" cols={cols} rows={data?.rows ?? null} total={data?.total ?? 0} page={Number(f.page)} pageSize={data?.page_size ?? 50}
        sort={f.sort} dir={f.dir as any} onSort={(sort, dir) => setF({ ...f, sort, dir, page: '1' })} onPage={(p) => setF({ ...f, page: String(p) })}
        exportAll={exportAll} empty="No consolidations here." />
    </div>
  );
}
export default function Page() { return <Suspense fallback={<div className="page"><p className="muted">Loading…</p></div>}><Register /></Suspense>; }
