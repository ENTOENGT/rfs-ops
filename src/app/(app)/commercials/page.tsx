'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api } from '@/components/api';
import { useMe } from '@/components/Shell';
import { DIVISIONS, divisionName } from '@/lib/commercialRules';

/** Commercials overview: where every enquiry stands, by division, Salesman and Coordinator (real counts, each a link into the list). */
function Overview() {
  const { me, can } = useMe();
  const division = useSearchParams().get('division') ?? '';
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => { setD(null); api(`/api/commercial/overview${division ? `?division=${division}` : ''}`).then(setD).catch((e) => setErr(e.message)); }, [division]);
  const list = (view: string, extra = '') => `/commercials/enquiries?view=${view}${division ? `&division=${division}` : ''}${extra}`;
  return (
    <div className="page">
      <div className="page-head"><h1>Commercials{division && ` — ${divisionName(division)}`}</h1><span className="spacer" />
        {can('jobfiles.create') && <Link className="btn primary" href="/job-files/new">New enquiry</Link>}</div>
      <div className="tabs link-tabs" role="tablist" style={{ marginBottom: 12 }}>
        {[['', 'All divisions'], ...DIVISIONS].map(([k, n]) => <Link key={k} role="tab" aria-selected={division === k} className={division === k ? 'on' : ''}
          href={k ? `/commercials?division=${k}` : '/commercials'}>{n}</Link>)}
      </div>
      {err && <div className="msg err">{err}</div>}
      {d && d.my_approvals > 0 && <div className="msg warn"><b>{d.my_approvals} quotation{d.my_approvals === 1 ? '' : 's'} waiting for your approval.</b>{' '}
        <Link href="/quotations?status=pending_approval&my_approval=1">Open them</Link></div>}
      {d && d.my_agent_requests > 0 && <div className="msg warn"><b>{d.my_agent_requests} rate request{d.my_agent_requests === 1 ? '' : 's'} assigned to you are waiting for rates.</b>{' '}
        <Link href="/vendor-requests?mine=assigned&status=requested">Open them</Link></div>}
      {!d && !err && <p className="muted">Loading…</p>}
      {d && <div className="kpis pro-tiles">
        {d.tiles.map((t: any) => <Link key={t.key} href={list(t.key)} className={`kpi${t.count ? '' : ' zero'}`}><b>{t.count}</b><span>{t.label}</span></Link>)}
      </div>}
      {d && <div className="grid g3" style={{ marginTop: 14, alignItems: 'start' }}>
        {!division && <div className="panel flush"><h2 style={{ padding: '12px 14px 0' }}>By division</h2>
          <table className="t"><thead><tr><th>Division</th><th className="num">Open</th><th className="num">Handed over</th><th className="num">Lost</th></tr></thead>
            <tbody>{d.by_division.map((r: any) => <tr key={r.division}><td>{r.division === 'none' ? 'Not set' : <Link href={`/commercials?division=${r.division}`}>{divisionName(r.division)}</Link>}</td>
              <td className="num">{r.open}</td><td className="num">{r.handed_over}</td><td className="num">{r.lost}</td></tr>)}
              {d.by_division.length === 0 && <tr><td colSpan={4} className="muted">No enquiries yet.</td></tr>}</tbody></table></div>}
        {[['by_salesman', 'By Salesman', 'salesman_id'], ['by_coordinator', 'By Coordinator', 'coordinator_id']].map(([k, title, param]) =>
          d[k].length > 0 && <div key={k} className="panel flush"><h2 style={{ padding: '12px 14px 0' }}>{title}</h2>
            <table className="t"><thead><tr><th>Name</th><th className="num">Open</th><th className="num">Pending approval</th><th className="num">Handed over</th></tr></thead>
              <tbody>{d[k].map((r: any) => <tr key={r.id}><td><Link href={list('c_all', `&${param}=${r.id}`)}>{r.full_name}</Link>{r.id === me.id && <span className="muted small"> (you)</span>}</td>
                <td className="num">{r.open}</td><td className="num">{r.pending_approval}</td><td className="num">{r.handed_over}</td></tr>)}</tbody></table></div>)}
      </div>}
    </div>
  );
}
export default function Page() { return <Suspense fallback={<div className="page"><p className="muted">Loading…</p></div>}><Overview /></Suspense>; }
