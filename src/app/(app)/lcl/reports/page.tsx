'use client';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api } from '@/components/api';
import { DataTable, Col } from '@/components/DataTable';
import { DIVISIONS } from '@/lib/commercialRules';

const REPORTS: [string, string][] = [
  ['consolidation_register', 'Consolidation register'], ['container_shipments', 'Container-wise shipment register'], ['mbl_register', 'Master BL register'],
  ['hbl_register', 'House BL register'], ['owner_wise', 'Cargo owner-wise report'], ['salesman_wise', 'Salesman-wise LCL shipments'],
  ['agent_wise', 'Agent-wise LCL shipments'], ['pending_receiving', 'Pending cargo receiving'], ['shortage_damage', 'Cargo shortage / damage'],
  ['weight_cbm', 'Consolidation weight and CBM'], ['stuffing_status', 'Stuffing status'], ['utilisation', 'Container utilisation'],
  ['departure_arrival', 'Departure and arrival tracking'], ['hbl_delivery', 'HBL-wise delivery status'],
];
const PAGE = 100;

function Reports() {
  const router = useRouter();
  const sp = useSearchParams();
  const r = sp.get('r') ?? 'consolidation_register';
  const [f, setF] = useState<Record<string, string>>({});
  const [data, setData] = useState<any>(null);
  const [page, setPage] = useState(1);
  const [err, setErr] = useState('');
  const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
  useEffect(() => { setData(null); setPage(1); api(`/api/lcl/reports/${r}?${qs}`).then((d) => { setData(d); setErr(''); }).catch((e) => setErr(e.message)); }, [r, qs]);
  const cols: Col<any>[] = (data?.columns ?? []).map((c: any, i: number) => ({ key: c.key, label: c.label, num: c.num, always: i === 0,
    text: (row: any) => { const v = row[c.key]; return c.num && v !== null && v !== undefined && v !== '' ? Number(v) : v; } }));
  const rows = (data?.rows ?? []).map((x: any, i: number) => ({ ...x, id: x.id ?? `${i}` }));
  return (
    <div className="page">
      <div className="page-head"><h1>LCL reports</h1></div>
      <div className="panel" style={{ marginBottom: 12 }}><div className="grid g4">
        <label className="f span2"><span>Report</span><select value={r} onChange={(e) => router.push(`/lcl/reports?r=${e.target.value}`)}>
          {REPORTS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
        <label className="f"><span>ETD from</span><input type="date" value={f.from ?? ''} onChange={(e) => setF({ ...f, from: e.target.value })} /></label>
        <label className="f"><span>ETD to</span><input type="date" value={f.to ?? ''} onChange={(e) => setF({ ...f, to: e.target.value })} /></label>
        <label className="f"><span>Division</span><select value={f.division ?? ''} onChange={(e) => setF({ ...f, division: e.target.value })}><option value="">All</option>
          {DIVISIONS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
      </div></div>
      {err && <div className="msg err">{err}</div>}
      {data && <h2 style={{ margin: '0 0 8px' }}>{data.title}</h2>}
      <DataTable id={`lclrep-${r}`} exportName={`lcl-${r}`} cols={cols} rows={data ? rows.slice((page - 1) * PAGE, page * PAGE) : null} total={rows.length}
        page={page} pageSize={PAGE} onPage={setPage} exportAll={async () => rows} empty="Nothing to show for these filters." />
    </div>
  );
}
export default function Page() { return <Suspense fallback={<div className="page"><p className="muted">Loading…</p></div>}><Reports /></Suspense>; }
