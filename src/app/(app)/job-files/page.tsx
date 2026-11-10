'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api, fmtDate } from '@/components/api';
import { useMe } from '@/components/Shell';
import { DIRECTIONS, MODES, JF_STATUSES } from '@/lib/jobfileRules';

function JobFiles() {
  const { can, lk } = useMe();
  const sp = useSearchParams();
  const fromUrl = () => ({ view: sp.get('status') ? '' : sp.get('view') ?? 'open', ...(sp.get('status') ? { status: sp.get('status')! } : {}), page: '1' });
  const [f, setF] = useState<Record<string, string>>(fromUrl);
  useEffect(() => { setF(fromUrl()); }, [sp]);  // eslint-disable-line react-hooks/exhaustive-deps
  const [tiles, setTiles] = useState<any[]>([]);
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const { view, page, ...rest } = f;
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v));
    const t = setTimeout(() => {
      api(`/api/job-files?${qs}`).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message));
      api(`/api/job-files?tiles=1&${new URLSearchParams(Object.entries(rest).filter(([, v]) => v))}`).then(setTiles).catch(() => {});
    }, 200);
    return () => clearTimeout(t);
  }, [f]);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value, page: '1' });
  const pages = data ? Math.max(1, Math.ceil(data.total / data.page_size)) : 1;
  const services = (r: any) => [r.needs_clearance && 'Clearance', r.needs_transport && 'Transport', r.needs_warehouse && 'Warehouse'].filter(Boolean).join(' · ') || '—';
  return (
    <div className="page">
      <div className="page-head"><h1>Job Files</h1><span className="spacer" />
        {can('jobfiles.create') && <Link className="btn primary" href="/job-files/new">New Job File</Link>}</div>
      <p className="muted small" style={{ marginTop: -6 }}>One Job File per shipment, by Job No. Truck trips and PRO requests with the same Job No. appear on it automatically.</p>
      <div className="kpis pro-tiles">
        {tiles.map((t) => <button key={t.key} className={`kpi${f.view === t.key ? ' on' : ''}`} onClick={() => setF({ ...f, view: f.view === t.key ? '' : t.key, page: '1' })}>
          <span className="kpi-n">{t.count}</span><span className="kpi-l">{t.label}</span></button>)}
      </div>
      <div className="panel" style={{ margin: '12px 0' }}><div className="grid g4">
        <label className="f"><span>Search</span><input value={f.q ?? ''} onChange={set('q')} placeholder="Job No., BL/AWB, container, carrier, port…" /></label>
        <label className="f"><span>Customer</span><select value={f.customer_id ?? ''} onChange={set('customer_id')}><option value="">All</option>
          {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="f"><span>Direction</span><select value={f.direction ?? ''} onChange={set('direction')}><option value="">All</option>
          {DIRECTIONS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>
        <label className="f"><span>Mode</span><select value={f.mode ?? ''} onChange={set('mode')}><option value="">All</option>
          {MODES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>
        <label className="f"><span>Status</span><select value={f.status ?? ''} onChange={set('status')}><option value="">All</option>
          {JF_STATUSES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>
        {can('jobfiles.view_all') && <label className="f"><span>Department</span><select value={f.department_id ?? ''} onChange={set('department_id')}><option value="">All</option>
          {lk.departments.filter((d: any) => d.side === 'operations').map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
        <label className="f"><span>Created from</span><input type="date" value={f.from ?? ''} onChange={set('from')} /></label>
        <label className="f"><span>Created to</span><input type="date" value={f.to ?? ''} onChange={set('to')} /></label>
      </div>
        <div style={{ marginTop: 10 }}><button className="btn small" onClick={() => setF({ view: '', page: '1' })}>Clear filters</button>
          {f.view && <span className="muted small" style={{ marginLeft: 10 }}>Showing: <b>{tiles.find((t) => t.key === f.view)?.label}</b></span>}</div></div>
      {err && <div className="msg err">{err}</div>}
      <div className="panel flush"><div className="table-wrap"><table className="t">
        <thead><tr><th>Job No.</th><th>Customer</th><th>Type</th><th>Route</th><th>BL / AWB</th><th>Containers</th><th>ETD</th><th>ETA</th><th>Services</th><th>Work</th><th>Status</th></tr></thead>
        <tbody>
          {data?.rows.map((r: any) => <tr key={r.id}>
            <td><Link href={`/job-files/${r.id}`}><b>{r.job_no}</b></Link>{r.department_name && <div className="muted small">{r.department_name}</div>}</td>
            <td>{r.customer_name}</td>
            <td className="small">{r.direction_name}<div className="muted">{r.mode_name}</div></td>
            <td className="small">{[r.port_of_loading ?? r.origin, r.port_of_discharge ?? r.destination].filter(Boolean).join(' → ') || '—'}</td>
            <td className="small">{r.hbl_hawb ?? r.mbl_mawb ?? '—'}</td>
            <td className="small">{r.container_list ?? '—'}</td>
            <td>{fmtDate(r.atd ?? r.etd)}{r.atd && <div className="muted small">actual</div>}</td>
            <td>{fmtDate(r.ata ?? r.eta)}{r.ata ? <div className="muted small">arrived</div> : r.late && <div className="flag">Late</div>}</td>
            <td className="small">{services(r)}</td>
            <td className="small">{r.trips} trip{r.trips === 1 ? '' : 's'}<div className="muted">{r.pro_requests} PRO</div></td>
            <td><span className="badge" style={{ background: r.status_color }}>{r.status_name}</span></td>
          </tr>)}
          {data && data.rows.length === 0 && <tr><td colSpan={11} className="muted" style={{ padding: 24, textAlign: 'center' }}>
            No Job Files here.{can('jobfiles.create') && <> <Link href="/job-files/new">Create one</Link>.</>}</td></tr>}
        </tbody></table></div>
        <div className="pager"><span>{data ? `${data.total} Job File${data.total === 1 ? '' : 's'}` : 'Loading…'}</span><span className="spacer" />
          <button className="btn small" disabled={f.page === '1'} onClick={() => setF({ ...f, page: String(Number(f.page) - 1) })}>Previous</button>
          <span>Page {f.page} of {pages}</span>
          <button className="btn small" disabled={Number(f.page) >= pages} onClick={() => setF({ ...f, page: String(Number(f.page) + 1) })}>Next</button></div>
      </div>
    </div>
  );
}
export default function JobFilesPage() { return <Suspense><JobFiles /></Suspense>; }
