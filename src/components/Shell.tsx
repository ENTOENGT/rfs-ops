'use client';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createContext, Suspense, useContext, useEffect, useState } from 'react';
import { api, fmtDateTime } from './api';

export interface Me {
  id: string; full_name: string; email: string; role: string; role_code: string; department: string | null;
  department_side: string | null; app_only: boolean;
  permissions: string[];
  financial_access: { buyingView: boolean; buyingEdit: boolean; sellingView: boolean; sellingEdit: boolean; profitView: boolean };
}
const MeCtx = createContext<{ me: Me; can: (p: string) => boolean; lk: any; reloadLookups: () => void } | null>(null);
export const useMe = () => useContext(MeCtx)!;

type Item = { href: string; label: string; perm?: string | string[]; phase?: number };
const COMMERCIAL = ['jobfiles.view_assigned', 'jobfiles.view_all', 'quotes.view', 'commercial.manage'];
/** The menu, grouped. Each person sees only the groups and items their role allows (the server checks again). */
const GROUPS: { key: string; label: string; perm?: string[]; items: Item[] }[] = [
  { key: 'commercials', label: 'Commercials', perm: COMMERCIAL, items: [
    { href: '/commercials', label: 'Overview' },
    { href: '/commercials?division=imports', label: 'Imports' },
    { href: '/commercials?division=exports', label: 'Exports' },
    { href: '/commercials?division=cross_trade', label: 'Cross Trade' }] },
  { key: 'enquiries', label: 'Enquiries', perm: COMMERCIAL, items: [
    { href: '/commercials/enquiries', label: 'All enquiries' },
    { href: '/commercials/enquiries?mine=1', label: 'My enquiries' },
    { href: '/commercials/enquiries?assigned=1', label: 'Assigned to me' },
    { href: '/job-files/new', label: 'New enquiry', perm: 'jobfiles.create' }] },
  { key: 'rates', label: 'Rates', perm: ['vendors.requests', 'vendors.manage', 'rates.agent_coordination'], items: [
    { href: '/vendor-requests?service=rate&rate_source=overseas_agent', label: 'Agent rate requests' },
    { href: '/vendor-requests?service=rate&rate_source=agent_coordinator', label: 'Via Agent Coordinator' },
    { href: '/vendor-requests?service=rate&rate_source=shipping_line', label: 'Direct liner rates' },
    { href: '/vendor-requests?service=rate&rate_source=airline', label: 'Direct airline rates' },
    { href: '/commercials/enquiries?view=c_quoting', label: 'Rate comparison', perm: COMMERCIAL }] },
  { key: 'quotations', label: 'Quotations', perm: ['quotes.view'], items: [
    { href: '/quotations?status=draft', label: 'Draft' },
    { href: '/quotations?status=pending_approval', label: 'Pending approval' },
    { href: '/quotations?status=approved', label: 'Approved' },
    { href: '/quotations?status=sent', label: 'Sent to customer' },
    { href: '/quotations?status=confirmed', label: 'Customer confirmed' },
    { href: '/quotations?status=closed_out', label: 'Rejected / expired' }] },
  { key: 'bookings', label: 'Bookings & pre-alerts', perm: COMMERCIAL, items: [
    { href: '/commercials/enquiries?view=c_confirmed', label: 'To book' },
    { href: '/commercials/enquiries?view=c_booking', label: 'Booking confirmation' },
    { href: '/vendor-requests?service=booking&status=open', label: 'Pending follow-ups' },
    { href: '/commercials/enquiries?view=c_prealert', label: 'Awaiting pre-alert' },
    { href: '/commercials/enquiries?view=c_prealert_received', label: 'Pre-alert to verify' }] },
  { key: 'handover', label: 'Handover', perm: COMMERCIAL, items: [
    { href: '/commercials/enquiries?view=c_awaiting_job', label: 'Awaiting job creation' },
    { href: '/commercials/enquiries?view=c_handed_over', label: 'Handed over to Operations' }] },
  { key: 'lcl', label: 'LCL management', perm: ['lcl.view', 'lcl.manage', 'lcl.receive', 'lcl.stuff'], items: [
    { href: '/lcl', label: 'Consolidation register' },
    { href: '/lcl/new', label: 'Create consolidation', perm: 'lcl.manage' },
    { href: '/lcl/shipments', label: 'House shipment register' },
    { href: '/lcl/reports?r=mbl_register', label: 'Master BL register' },
    { href: '/lcl/shipments?view=hbl', label: 'House BL register' },
    { href: '/lcl?view=in_transit', label: 'Container monitoring' },
    { href: '/lcl/shipments?view=pending_receiving', label: 'Cargo receiving' },
    { href: '/lcl?view=stuffing', label: 'Stuffing and dispatch' },
    { href: '/lcl/reports', label: 'LCL reports' }] },
  { key: 'operations', label: 'Operations', items: [
    { href: '/job-files', label: 'Job Files', perm: ['jobfiles.view_all', 'jobfiles.view_department', 'jobfiles.view_handed_over', 'jobfiles.edit'] },
    { href: '/cases', label: 'Customer service', perm: ['cases.view_all', 'cases.manage'] },
    { href: '/vendor-requests', label: 'Vendor requests', perm: ['vendors.requests', 'vendors.manage'] },
    { href: '/warehouse', label: 'Warehouse', perm: ['warehouse.view', 'warehouse.receive', 'warehouse.dispatch', 'warehouse.configure', 'warehouse.orders.create'] },
    { href: '/requests', label: 'Transport requests', perm: 'jobs.view' },
    { href: '/jobs', label: 'Jobs', perm: 'jobs.view' },
    { href: '/documents', label: 'Documents', perm: 'jobs.view' },
    { href: '/runs', label: 'Messenger runs', perm: ['runs.view_all', 'runs.view_department', 'runs.create', 'runs.update_status'] },
    { href: '/pro', label: 'PRO clearance', perm: ['pro.view_all', 'pro.view_department', 'pro.create', 'pro.update', 'pro.assign'] }] },
  { key: 'fleet', label: 'Fleet', items: [
    { href: '/drivers', label: 'Drivers', perm: 'jobs.view' },
    { href: '/vehicles', label: 'Vehicles', perm: 'jobs.view' },
    { href: '/subcontractors', label: 'Rental companies', perm: 'vehicles.manage' },
    { href: '/rental_rates', label: 'Rental rates', perm: 'vehicles.manage' }] },
  { key: 'lists', label: 'Lists', items: [
    { href: '/customers', label: 'Customers', perm: ['jobs.view', 'customers.manage'] },
    { href: '/vendors', label: 'Vendors', perm: 'vendors.manage' },
    { href: '/locations', label: 'Locations', perm: 'jobs.view' }] },
  { key: 'finance', label: 'Reports & finance', items: [
    { href: '/financials', label: 'Financials', perm: ['finance.buying.view', 'finance.selling.view'] },
    { href: '/reports', label: 'Reports', perm: 'reports.view' },
    { href: '/erp', label: 'ERP export', perm: ['erp.view', 'erp.export'] }] },
];
/** The side menu. Groups fold and unfold; the open/closed choice is remembered in this browser. */
function SideNav({ can, lk, path, adminLinks }: { can: (p: string) => boolean; lk: any; path: string; adminLinks: Item[] }) {
  const search = useSearchParams().toString();
  const [closed, setClosed] = useState<string[]>([]);
  useEffect(() => { try { setClosed(JSON.parse(localStorage.getItem('nav.closed') ?? '[]')); } catch { /* no storage */ } }, []);
  const toggle = (k: string) => setClosed((c) => {
    const n = c.includes(k) ? c.filter((x) => x !== k) : [...c, k];
    try { localStorage.setItem('nav.closed', JSON.stringify(n)); } catch { /* no storage */ }
    return n;
  });
  const here = path + (search ? `?${search}` : '');
  const all = GROUPS.flatMap((g) => g.items.map((i) => i.href));
  const isOn = (href: string) => href.includes('?') ? here === href
    : (path === href && !all.some((h) => h.startsWith(href + '?') && here === h)) || (path.startsWith(href + '/') && !all.some((h) => h !== href && !h.includes('?') && h.startsWith(href + '/') && path.startsWith(h)));
  const link = (i: Item) => (
    <Link key={i.href} href={i.href} className={isOn(i.href) ? 'on' : ''}>
      {i.label}{i.phase && <span className="soon">Phase {i.phase}</span>}
    </Link>
  );
  const allowed = (p?: string | string[]) => !p || (Array.isArray(p) ? p.some(can) : can(p));
  const groups = GROUPS.filter((g) => allowed(g.perm)).map((g) => ({ ...g, items: g.items.filter((i) => allowed(i.perm))
    .filter((i) => i.href !== '/financials' || lk.money_screens !== false) })).filter((g) => g.items.length);
  return (
    <nav className="nav">
      {link({ href: '/dashboard', label: 'Dashboard' })}
      {groups.map((g) => {
        const active = g.items.some((i) => isOn(i.href));
        const shut = closed.includes(g.key) && !active;
        return <div key={g.key} className="navgroup">
          <button type="button" className="group" aria-expanded={!shut} onClick={() => toggle(g.key)}>{g.label}<span aria-hidden>{shut ? '+' : '–'}</span></button>
          {!shut && g.items.map(link)}
        </div>;
      })}
      {adminLinks.length > 0 && <div className="navgroup"><div className="group">Administration</div>{adminLinks.map(link)}</div>}
    </nav>
  );
}

const ADMIN: (Item & { perm: string[] })[] = [
  { href: '/users', label: 'Users', perm: ['users.manage', 'users.manage_department'] },
  { href: '/roles', label: 'Roles & permissions', perm: ['roles.manage', 'roles.manage_department'] },
  { href: '/settings', label: 'Settings', perm: ['settings.manage'] },
];

function Bell({ jobHref = (id: string) => `/jobs/${id}` }: { jobHref?: (id: string) => string }) {
  const [n, setN] = useState<{ unread: number; rows: any[] }>({ unread: 0, rows: [] });
  const [open, setOpen] = useState(false);
  const load = () => api('/api/notifications').then(setN).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, []);
  return (
    <div className="bell" style={{ position: 'relative' }}>
      <button className="btn small" onClick={() => { setOpen(!open); if (!open && n.unread) api('/api/notifications', { body: {} }).then(load); }}>
        Notifications {n.unread > 0 && <span className="dot">{n.unread}</span>}
      </button>
      {open && (
        <div className="dropdown" onMouseLeave={() => setOpen(false)}>
          {n.rows.length === 0 && <div style={{ padding: 12 }} className="muted">You're all caught up.</div>}
          {n.rows.map((r) => (
            <Link key={r.id} href={r.case_id ? `/cases/${r.case_id}` : r.quotation_id ? `/quotations/${r.quotation_id}` : r.job_file_id ? `/job-files/${r.job_file_id}` : r.pro_id ? `/pro/${r.pro_id}` : r.run_id ? `/runs/${r.run_id}` : r.job_id ? jobHref(r.job_id) : '#'} className={r.read_at ? '' : 'unread'} onClick={() => setOpen(false)}>
              {r.title}<div className="muted small">{fmtDateTime(r.created_at)}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Shell({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [lk, setLk] = useState<any>(null);
  const [q, setQ] = useState('');
  const path = usePathname();
  const router = useRouter();
  useEffect(() => {
    api<Me & { must_change_password: boolean }>('/api/auth/me').then((m) => {
      if (m.must_change_password) { location.href = '/change-password'; return; }
      setMe(m);
      api('/api/lookups').then(setLk);
    });
  }, []);
  const appHome = me?.app_only ? (me.permissions.includes('jobs.view_assigned') ? '/my-jobs'
    : me.permissions.includes('pro.update') && !me.permissions.includes('runs.update_status') ? '/pro' : '/runs') : null;
  const appAllowed = !appHome || ['/my-jobs', '/runs', '/pro', '/change-password'].some((p) => path.startsWith(p));
  useEffect(() => { if (appHome && !appAllowed) router.replace(appHome); }, [appHome, appAllowed]);
  if (!me || !lk || !appAllowed) return <div className="page muted">Loading…</div>;
  const can = (p: string) => me.permissions.includes(p);
  const logout = async () => { await api('/api/auth/logout', { body: {} }); location.href = '/login'; };
  if (appHome) return (
    // Phone app for drivers and messengers: no sidebar, big touch targets, only their own work.
    <MeCtx.Provider value={{ me, can, lk, reloadLookups: () => api('/api/lookups').then(setLk) }}>
      <div className="app-shell">
        <header className="app-top">
          <Link href={appHome} className="app-brand"><img src="/brand/mark-on-dark.png" alt="" width={30} height={28} />
            <span>{appHome === '/my-jobs' ? 'My jobs' : appHome === '/pro' ? 'My PRO work' : 'My runs'}</span></Link>
          <span className="spacer" />
          <Bell jobHref={(id) => `/my-jobs/${id}`} />
          <button className="btn small" onClick={() => confirm('Sign out of the app?') && logout()}>Sign out</button>
        </header>
        <main className="app-main">{children}</main>
        <footer className="app-foot muted small">{me.full_name} · Reliance Freight Systems</footer>
      </div>
    </MeCtx.Provider>
  );
  const adminLinks = ADMIN.filter((i) => i.perm.some(can));
  return (
    <MeCtx.Provider value={{ me, can, lk, reloadLookups: () => api('/api/lookups').then(setLk) }}>
      <div className="shell">
        <aside className="side">
          <div className="brand">
            <img src="/brand/logo-on-dark.png" alt="Reliance Freight Systems LLC" width={184} height={44} />
            <small>Freight &amp; 3PL Operations · {me.department ?? me.role}</small>
          </div>
          <Suspense fallback={<nav className="nav" />}>
            <SideNav can={can} lk={lk} path={path} adminLinks={adminLinks} />
          </Suspense>
        </aside>
        <div className="main">
          <header className="top">
            <form className="search" onSubmit={(e) => { e.preventDefault(); router.push(`/jobs?q=${encodeURIComponent(q)}`); }}>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search job no., BOE, driver, vehicle, customer, email subject…" aria-label="Search jobs" />
            </form>
            <Bell />
            <div className="who">{me.full_name}<small>{me.role}</small></div>
            <button className="btn small" onClick={logout}>Sign out</button>
          </header>
          {children}
        </div>
      </div>
    </MeCtx.Provider>
  );
}
