'use client';
/**
 * Role dashboard (UI redesign): the person's own figures first (every number is a count of real records they may open),
 * then what needs their hand, the weekly enquiry trend, the pipeline and their latest notifications. Transport and
 * messenger figures follow for people who run trips.
 */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDateTime, fmtMoney } from '@/components/api';
import { useMe } from '@/components/Shell';
import { Icon } from '@/components/Icon';
import { period } from '@/lib/period';
import { stageName, stageColor } from '@/lib/commercialRules';

const WHY: Record<string, string> = { c_approval: 'Approve the quotation', c_awaiting_job: 'Type the ERP Job No. and hand over', c_confirmed: 'Customer confirmed — book it',
  c_bl_correction: 'BL draft correction', c_prealert_received: 'Verify the pre-alert', c_quoting: 'Rates in — make the quotation', c_rates: 'Chase the agents for rates', c_sent: 'Follow up with the customer' };
const greeting = () => { const h = new Date().getHours(); return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'; };

function Stat({ c }: { c: any }) {
  return <Link href={c.href} className={`stat${c.tone ? ` tone-${c.tone}` : ''}${c.count === 0 ? ' zero' : ''}`}>
    <div className="stat-top"><span className="stat-ic"><Icon name={c.icon} size={18} /></span><Icon name="arrowRight" size={16} className="stat-go" /></div>
    <span className="stat-n">{c.count}</span>
    <span className="stat-l">{c.label}</span>
    {c.hint && <span className="stat-h">{c.hint}</span>}
  </Link>;
}

export default function Dashboard() {
  const { me, can, lk } = useMe();
  const [h, setH] = useState<any>(null);
  const [rc, setRc] = useState<any>(null);
  const [key, setKey] = useState('this_month');
  const [custom, setCustom] = useState<[string, string]>(['', '']);
  const [k, setK] = useState<any>(null);
  useEffect(() => { api('/api/home').then(setH).catch(() => setH({ sections: [], tasks: [], weekly: [], pipeline: [], feed: [] })); }, []);
  const seesAllRuns = can('runs.view_all') || can('runs.view_department');
  useEffect(() => { if (me.permissions.some((p) => p.startsWith('runs.'))) api('/api/runs/summary').then(setRc).catch(() => {}); }, []);  // eslint-disable-line react-hooks/exhaustive-deps
  const [from, to] = key === 'custom' ? custom : period(key, lk.timezone);
  useEffect(() => { if (from && to && can('jobs.view')) api(`/api/dashboard?from=${from}&to=${to}`).then(setK); }, [from, to]);  // eslint-disable-line react-hooks/exhaustive-deps
  const f = k?.financials ?? {};
  const cur = lk.currency;
  const maxW = Math.max(1, ...(h?.weekly ?? []).map((w: any) => w.count));
  const maxP = Math.max(1, ...(h?.pipeline ?? []).map((p: any) => p.count));
  const primary = can('jobfiles.create') ? { href: '/job-files/new', label: 'New enquiry' } : can('quotes.create') ? { href: '/quotations/new', label: 'New quotation' }
    : can('warehouse.receive') ? { href: '/warehouse/receipts/new', label: 'New goods receipt' } : can('jobs.create') ? { href: '/requests/new', label: 'New transport request' } : can('lcl.manage') ? { href: '/lcl/new', label: 'New consolidation' } : null;
  const today = new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const nothing = h && !h.sections.length && !can('jobs.view') && !rc;
  return (
    <div className="page">
      <div className="dash-hello">
        <div><h1>{greeting()}, {me.full_name.split(' ')[0]}</h1><p>{today} · {me.role}{me.department ? `, ${me.department}` : ''}</p></div>
        <span className="spacer" />
        {primary && <Link className="btn primary" href={primary.href}><Icon name="plus" size={16} />{primary.label}</Link>}
      </div>

      {!h && <p className="muted">Loading your figures…</p>}
      {h?.sections.map((s: any) => <section key={s.key} style={{ marginBottom: 22 }}>
        <div className="section-title" style={{ marginTop: 0 }}>{s.title}</div>
        <div className="stats">{s.cards.map((c: any) => <Stat key={c.key} c={c} />)}</div>
      </section>)}

      {h && (h.tasks.length > 0 || h.weekly.length > 0 || h.feed.length > 0) && <div className="dash-cols">
        <div className="dash-col">
          {h.weekly.length > 0 && <div className="panel">
            <div className="panel-head"><h2>Enquiries per week</h2><span className="muted small">last 8 weeks</span></div>
            <div className="bars" role="img" aria-label={`Enquiries per week: ${h.weekly.map((w: any) => `${w.week} ${w.count}`).join(', ')}`}>
              {h.weekly.map((w: any, i: number) => <div key={w.week} className={`bar${i === h.weekly.length - 1 ? ' now' : ''}`}>
                <b>{w.count}</b><i style={{ height: `${(w.count / maxW) * 100}%` }} /></div>)}
            </div>
            <div className="bar-x">{h.weekly.map((w: any) => <span key={w.week}>{w.week}</span>)}</div>
          </div>}
          <div className="panel">
            <div className="panel-head"><h2>Needs your attention</h2>{h.tasks.length > 0 && <Link href="/commercials/enquiries?view=c_open">All open enquiries</Link>}</div>
            {h.tasks.length === 0 ? <div className="empty"><b>Nothing waiting</b>New work shows here as soon as it needs you.</div>
              : h.tasks.map((t: any) => <Link key={t.id} href={`/job-files/${t.id}`} className="task">
                <span className="task-dot" style={{ background: stageColor(t.stage) }} />
                <span style={{ minWidth: 0 }}><b>{WHY[t.why] ?? stageName(t.stage)}</b>
                  <small>{[t.job_no && t.job_no !== t.enquiry_ref ? t.job_no : t.shipping_ref ?? t.enquiry_ref, t.customer_name,
                    [t.port_of_loading ?? t.origin, t.port_of_discharge ?? t.destination].filter(Boolean).join(' → ')].filter(Boolean).join(' · ')}</small></span>
                <span className="badge" style={{ background: stageColor(t.stage) }}>{stageName(t.stage)}</span></Link>)}
          </div>
        </div>
        <div className="dash-col">
          {h.pipeline.length > 0 && <div className="panel">
            <div className="panel-head"><h2>Pipeline</h2><Link href="/commercials">Overview</Link></div>
            {h.pipeline.map((p: any) => <Link key={p.key} href={`/commercials/enquiries?view=${p.key}`} className="funnel-row">
              <span className="funnel-l">{p.label}</span><span className="funnel-track"><i style={{ width: `${(p.count / maxP) * 100}%` }} /></span><span className="funnel-n">{p.count}</span></Link>)}
          </div>}
          <div className="panel">
            <div className="panel-head"><h2>Recent activity</h2><Link href="/notifications">See all</Link></div>
            {h.feed.length === 0 ? <div className="empty"><b>No activity yet</b>Updates on your shipments appear here.</div>
              : h.feed.map((n: any) => <Link key={n.id} className="feed-item" href={n.job_file_id ? `/job-files/${n.job_file_id}` : n.quotation_id ? `/quotations/${n.quotation_id}` : n.vendor_request_id ? `/vendor-requests/${n.vendor_request_id}` : '/notifications'}>
                <span className="feed-ic"><Icon name="bell" size={15} /></span>
                <span><span>{n.title}</span><small>{n.actor_name ? `${n.actor_name} · ` : ''}{fmtDateTime(n.created_at)}</small></span></Link>)}
          </div>
        </div>
      </div>}

      {rc && rc.pending !== undefined && <section style={{ marginTop: 26 }}>
        <div className="section-title">Messenger runs</div>
        <div className="stats">
          {seesAllRuns && <Stat c={{ key: 'p', label: 'Waiting for a messenger', count: rc.pending, href: '/runs?status=pending', icon: 'clock', tone: 'warn' }} />}
          <Stat c={{ key: 'a', label: seesAllRuns ? 'Assigned' : 'Assigned to me', count: rc.assigned, href: '/runs', icon: 'mail' }} />
          <Stat c={{ key: 'c', label: 'Collected, on the way', count: rc.collected, href: '/runs', icon: 'truck', tone: 'teal' }} />
          <Stat c={{ key: 'f', label: 'Could not complete', count: rc.failed, href: '/runs', icon: 'alert', tone: 'danger' }} />
          <Stat c={{ key: 'd', label: 'Delivered today', count: rc.delivered_today, href: '/runs', icon: 'arrowRight', tone: 'ok' }} />
        </div>
      </section>}

      {can('jobs.view') && <section style={{ marginTop: 26 }}>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
          <div className="section-title" style={{ margin: 0 }}>Transport</div><span className="spacer" />
          <select value={key} onChange={(e) => setKey(e.target.value)} style={{ width: 170 }} aria-label="Period">
            <option value="today">Today</option><option value="yesterday">Yesterday</option><option value="this_week">This week</option><option value="last_week">Last week</option>
            <option value="this_month">This month</option><option value="last_month">Last month</option><option value="this_year">This year</option><option value="custom">Custom range</option>
          </select>
          {key === 'custom' && <>
            <input type="date" style={{ width: 150 }} value={custom[0]} onChange={(e) => setCustom([e.target.value, custom[1]])} aria-label="From" />
            <input type="date" style={{ width: 150 }} value={custom[1]} onChange={(e) => setCustom([custom[0], e.target.value])} aria-label="To" />
          </>}
        </div>
        <div className="stats">
          <Stat c={{ key: 't', label: "Today's jobs", count: k?.today_jobs ?? 0, href: '/jobs', icon: 'truck' }} />
          <Stat c={{ key: 'p', label: 'Pending assignment', count: k?.pending ?? 0, href: '/requests', icon: 'clock', tone: 'warn' }} />
          <Stat c={{ key: 'a', label: 'Assigned', count: k?.assigned ?? 0, href: '/jobs?status=assigned', icon: 'calendar' }} />
          <Stat c={{ key: 'i', label: 'In transit', count: k?.in_transit ?? 0, href: '/jobs?status=in_transit', icon: 'truck', tone: 'teal' }} />
          <Stat c={{ key: 'pod', label: 'Delivered, POD missing', count: k?.pod_pending ?? 0, href: '/jobs?action_required=pod', icon: 'alert', tone: 'danger' }} />
          <Stat c={{ key: 'c', label: 'Completed', count: k?.completed ?? 0, href: '/jobs?status=completed', icon: 'arrowRight', tone: 'ok' }} />
        </div>
        {k?.financials && <div className="kpis" style={{ marginTop: 12 }}>
          {'net_revenue' in f && <div className="kpi money"><b>{fmtMoney(f.net_revenue, cur)}</b><span>Revenue before VAT</span></div>}
          {'total_cost' in f && <div className="kpi money"><b>{fmtMoney(f.total_cost, cur)}</b><span>Transport cost</span></div>}
          {f.profit && <div className="kpi money"><b>{fmtMoney(f.profit.gross_profit, cur)}</b><span>Gross profit</span></div>}
          {f.profit && <div className="kpi money"><b>{f.profit.margin_pct ?? '–'}%</b><span>Margin</span></div>}
        </div>}
        <p className="muted small" style={{ marginTop: 10 }}>Transport figures cover jobs with a required date from {from} to {to}.</p>
      </section>}

      {nothing && <div className="panel"><div className="empty"><b>Welcome to RFS Ops</b>Use the menu on the left to open your work. Administrators can set up the team under Administration → Users.</div></div>}
    </div>
  );
}
