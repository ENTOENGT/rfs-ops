'use client';
/**
 * The application frame (UI redesign).
 *   Primary sidebar   — the modules only (icon + name); collapses to icons.
 *   Secondary panel   — the selected module's pages, grouped; collapses.
 *   Header            — where you are (breadcrumb), global search, "+ New", notifications, settings, profile.
 * Drivers, messengers and PRO staff keep their phone app frame. Every page keeps its URL.
 */
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { createContext, Suspense, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api, fmtDateTime } from './api';
import { Icon } from './Icon';
import { QUICK_CREATE, locate, isOn, visibleModules, NavModule } from '@/lib/navigation';

export interface Me {
  id: string; full_name: string; email: string; role: string; role_code: string; department: string | null;
  department_side: string | null; app_only: boolean;
  permissions: string[];
  financial_access: { buyingView: boolean; buyingEdit: boolean; sellingView: boolean; sellingEdit: boolean; profitView: boolean };
}
const MeCtx = createContext<{ me: Me; can: (p: string) => boolean; lk: any; reloadLookups: () => void } | null>(null);
export const useMe = () => useContext(MeCtx)!;

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* no storage */ } },
};
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');
const notifHref = (r: any, jobHref: (id: string) => string) => r.case_id ? `/cases/${r.case_id}` : r.job_file_id ? `/job-files/${r.job_file_id}` : r.quotation_id ? `/quotations/${r.quotation_id}`
  : r.vendor_request_id ? `/vendor-requests/${r.vendor_request_id}` : r.pro_id ? `/pro/${r.pro_id}` : r.run_id ? `/runs/${r.run_id}` : r.job_id ? jobHref(r.job_id) : '/notifications';

/** Close a popover when the person clicks elsewhere or presses Escape. */
function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', click); document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', click); document.removeEventListener('keydown', key); };
  }, [open]);  // eslint-disable-line react-hooks/exhaustive-deps
  return ref;
}

function Bell({ jobHref = (id: string) => `/jobs/${id}`, compact }: { jobHref?: (id: string) => string; compact?: boolean }) {
  const [n, setN] = useState<{ unread: number; rows: any[] }>({ unread: 0, rows: [] });
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  const load = () => api('/api/notifications').then(setN).catch(() => {});
  useEffect(() => { load(); const t = setInterval(load, 60000); return () => clearInterval(t); }, []);
  return (
    <div className="bell" ref={ref}>
      <button className={compact ? 'btn small' : 'icon-btn'} aria-label={`Notifications${n.unread ? `, ${n.unread} unread` : ''}`} aria-expanded={open}
        onClick={() => { setOpen(!open); if (!open && n.unread) api('/api/notifications', { body: {} }).then(load); }}>
        {compact ? 'Notifications' : <Icon name="bell" />}{n.unread > 0 && <span className="dot">{n.unread > 99 ? '99+' : n.unread}</span>}
      </button>
      {open && <div className="dropdown pop-right" role="dialog" aria-label="Notifications">
        <div className="pop-head"><b>Notifications</b><Link href="/notifications" onClick={() => setOpen(false)}>See all</Link></div>
        {n.rows.length === 0 && <div className="pop-empty">You're all caught up.</div>}
        {n.rows.slice(0, 12).map((r) => <Link key={r.id} href={notifHref(r, jobHref)} className={`pop-item${r.read_at ? '' : ' unread'}`} onClick={() => setOpen(false)}>
          <span>{r.title}</span><small>{fmtDateTime(r.created_at)}</small></Link>)}
      </div>}
    </div>
  );
}

/** Search across shipments, quotations, customers, agents, consolidations, transport jobs and saved emails. */
function GlobalSearch() {
  const router = useRouter();
  const [q, setQ] = useState('');
  const [res, setRes] = useState<any>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const ref = useOutside(open, () => setOpen(false));
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement)?.tagName);
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) { e.preventDefault(); input.current?.focus(); }
    };
    document.addEventListener('keydown', key); return () => document.removeEventListener('keydown', key);
  }, []);
  useEffect(() => {
    if (q.trim().length < 2) { setRes(null); return; }
    setBusy(true);
    const t = setTimeout(() => api(`/api/search?q=${encodeURIComponent(q.trim())}`).then((r) => { setRes(r); setOpen(true); }).catch(() => setRes(null)).finally(() => setBusy(false)), 250);
    return () => clearTimeout(t);
  }, [q]);
  const flat: any[] = res?.groups?.flatMap((g: any) => g.rows) ?? [];
  const go = (href: string) => { setOpen(false); setQ(''); router.push(href); };
  return (
    <div className="gsearch" ref={ref}>
      <form role="search" onSubmit={(e) => { e.preventDefault(); if (flat[0]) go(flat[0].href); }}>
        <Icon name="search" size={17} className="gsearch-i" />
        <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} onFocus={() => res && setOpen(true)}
          placeholder="Search enquiry, SR, job, booking, BL, container, customer, agent, email…" aria-label="Search everything" />
        <kbd>/</kbd>
      </form>
      {open && q.trim().length >= 2 && <div className="dropdown gsearch-pop" role="listbox" aria-label="Search results">
        {busy && !res && <div className="pop-empty">Searching…</div>}
        {res && flat.length === 0 && <div className="pop-empty">Nothing found for “{q}”.</div>}
        {res?.groups?.filter((g: any) => g.rows.length).map((g: any) => <div key={g.key} className="gs-group">
          <div className="gs-label">{g.label}</div>
          {g.rows.map((r: any) => <button key={r.href} className="gs-row" onClick={() => go(r.href)}>
            <span className="gs-title">{r.title}</span><span className="gs-sub">{r.sub}</span>{r.tag && <span className="gs-tag">{r.tag}</span>}</button>)}
        </div>)}
      </div>}
    </div>
  );
}

function QuickCreate({ can }: { can: (p: string) => boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  const items = QUICK_CREATE.filter((i) => can(i.perm));
  if (!items.length) return null;
  return (
    <div className="qc" ref={ref}>
      <button className="btn accent" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="plus" size={16} /> <span className="hide-sm">New</span></button>
      {open && <div className="dropdown pop-right menu" role="menu">
        {items.map((i) => <Link key={i.href} href={i.href} role="menuitem" onClick={() => setOpen(false)}>{i.label}</Link>)}</div>}
    </div>
  );
}

function Profile({ me, logout }: { me: Me; logout: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useOutside(open, () => setOpen(false));
  return (
    <div className="profile" ref={ref}>
      <button className="avatar-btn" aria-expanded={open} aria-label="Your account" onClick={() => setOpen(!open)}>
        <span className="avatar">{initials(me.full_name)}</span>
        <span className="who hide-md"><b>{me.full_name}</b><small>{me.role}</small></span><Icon name="chevronDown" size={15} className="hide-md" />
      </button>
      {open && <div className="dropdown pop-right menu" role="menu">
        <div className="pop-head col"><b>{me.full_name}</b><small>{me.email}</small><small>{me.role}{me.department ? ` · ${me.department}` : ''}</small></div>
        <Link href="/notifications" role="menuitem" onClick={() => setOpen(false)}><Icon name="bell" size={16} /> Notifications</Link>
        <Link href="/change-password" role="menuitem" onClick={() => setOpen(false)}><Icon name="key" size={16} /> Change password</Link>
        <button role="menuitem" onClick={logout}><Icon name="logout" size={16} /> Sign out</button>
      </div>}
    </div>
  );
}

const DETAIL: [RegExp, string][] = [[/^\/job-files\/[^/]+$/, 'Shipment'], [/^\/quotations\/[^/]+\/print$/, 'Customer copy'], [/^\/quotations\/[^/]+$/, 'Quotation'],
  [/^\/lcl\/[^/]+$/, 'Consolidation'], [/^\/vendor-requests\/[^/]+$/, 'Vendor request'], [/\/new$/, 'New'], [/^\/jobs\/[^/]+$/, 'Job'], [/^\/pro\/[^/]+$/, 'PRO request'],
  [/^\/runs\/[^/]+$/, 'Run'], [/^\/cases\/[^/]+$/, 'Case'], [/^\/warehouse\/(receipts|orders)\/[^/]+$/, 'Details'], [/^\/notifications$/, 'Notifications'], [/^\/change-password$/, 'Change password']];

function Frame({ me, lk, can, children }: { me: Me; lk: any; can: (p: string) => boolean; children: React.ReactNode }) {
  const path = usePathname();
  const search = useSearchParams().toString();
  const router = useRouter();
  const mods = useMemo(() => visibleModules(can, { moneyScreens: lk.money_screens !== false }), [me.id]);  // eslint-disable-line react-hooks/exhaustive-deps
  const [pref, setPref] = useState<string | null>(null);
  const [mini, setMini] = useState(false);
  const [subOpen, setSubOpen] = useState(true);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => {
    try { setPref(sessionStorage.getItem('nav.module')); } catch { /* none */ }
    setMini(store.get('nav.mini') === '1'); setSubOpen(store.get('nav.sub') !== '0');
  }, []);
  const where = locate(mods, path, search, pref);
  const mod: NavModule | null = where.mod;
  useEffect(() => { if (mod && mod.key !== pref) { setPref(mod.key); try { sessionStorage.setItem('nav.module', mod.key); } catch { /* none */ } } }, [mod?.key]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setDrawer(false); }, [path, search]);
  const pick = (m: NavModule) => {
    if (m.key === mod?.key && m.key !== 'dashboard') { const v = !subOpen; setSubOpen(v); store.set('nav.sub', v ? '1' : '0'); return; }
    setPref(m.key); try { sessionStorage.setItem('nav.module', m.key); } catch { /* none */ }
    if (!subOpen) { setSubOpen(true); store.set('nav.sub', '1'); }
    router.push(m.items[0].href);
  };
  const toggleMini = () => { const v = !mini; setMini(v); store.set('nav.mini', v ? '1' : '0'); };
  const all = mods.flatMap((m) => m.items.map((i) => i.href));
  const sections = mod ? mod.items.reduce<[string, typeof mod.items][]>((acc, i) => {
    const s = i.section ?? ''; const g = acc.find(([k]) => k === s); if (g) g[1].push(i); else acc.push([s, [i]]); return acc; }, []) : [];
  const showSub = !!mod && mod.key !== 'dashboard' && (mod.items.length > 1 || mod.key === 'documents');
  const crumbDetail = where.item ? null : DETAIL.find(([re]) => re.test(path))?.[1];
  const logout = async () => { await api('/api/auth/logout', { body: {} }); location.href = '/login'; };
  return (
    <div className={`shell${mini ? ' rail-min' : ''}${showSub && subOpen ? ' has-sub' : ''}${drawer ? ' drawer-open' : ''}`}>
      <aside className="rail" aria-label="Modules">
        <Link href="/dashboard" className="rail-brand" aria-label="Reliance Freight Systems — Dashboard">
          <img className="rail-logo" src="/brand/logo-on-dark.png" alt="" width={168} height={40} />
          <img className="rail-mark" src="/brand/mark-on-dark.png" alt="" width={34} height={31} />
        </Link>
        <nav className="rail-nav">
          {mods.map((m) => <button key={m.key} className={`rail-item${mod?.key === m.key ? ' on' : ''}`} onClick={() => pick(m)} title={mini ? m.label : undefined}
            aria-current={mod?.key === m.key ? 'true' : undefined}>
            <Icon name={m.icon} size={19} /><span>{m.label}</span></button>)}
        </nav>
        <div className="rail-foot">
          <button className="rail-item" onClick={toggleMini} title={mini ? 'Expand menu' : undefined}><Icon name={mini ? 'chevronRight' : 'chevronLeft'} size={19} /><span>Collapse</span></button>
          <div className="rail-user" title={mini ? `${me.full_name} · ${me.role}` : undefined}><span className="avatar">{initials(me.full_name)}</span>
            <span className="rail-user-t"><b>{me.full_name}</b><small>{me.role}</small></span></div>
        </div>
      </aside>
      {showSub && subOpen && <aside className="subnav" aria-label={`${mod!.label} pages`}>
        <div className="subnav-head"><div><small>Module</small><b>{mod!.label}</b></div>
          <button className="icon-btn sm" aria-label="Hide this menu" onClick={() => { setSubOpen(false); store.set('nav.sub', '0'); }}><Icon name="panel" size={17} /></button></div>
        <nav>
          {sections.map(([s, items]) => <div key={s || 'main'} className="subnav-sec">
            {s && <div className="subnav-label">{s}</div>}
            {items.map((i) => <Link key={i.href} href={i.href} className={isOn(i.href, path, search, all) ? 'on' : ''} aria-current={isOn(i.href, path, search, all) ? 'page' : undefined}>{i.label}</Link>)}
          </div>)}
        </nav>
      </aside>}
      <div className="scrim" onClick={() => setDrawer(false)} aria-hidden />
      <div className="main">
        <header className="top">
          <button className="icon-btn show-sm" aria-label="Open the menu" onClick={() => setDrawer(true)}><Icon name="menu" /></button>
          {showSub && !subOpen && <button className="icon-btn hide-sm" aria-label={`Show the ${mod!.label} menu`} title={`Show the ${mod!.label} menu`}
            onClick={() => { setSubOpen(true); store.set('nav.sub', '1'); }}><Icon name="panel" /></button>}
          <nav className="crumbs" aria-label="Breadcrumb">
            {mod && mod.key !== 'dashboard' ? <>
              <Link href={mod.items[0].href}>{mod.label}</Link>
              {(where.item || crumbDetail) && <><Icon name="chevronRight" size={14} /><span aria-current="page">{where.item?.label ?? crumbDetail}</span></>}
            </> : <span aria-current="page">{crumbDetail ?? 'Dashboard'}</span>}
          </nav>
          <GlobalSearch />
          <div className="top-actions">
            <QuickCreate can={can} />
            <Bell />
            {can('settings.manage') && <Link className="icon-btn hide-sm" href="/settings" aria-label="Settings" title="Settings"><Icon name="gear" /></Link>}
            <Profile me={me} logout={logout} />
          </div>
        </header>
        {children}
      </div>
    </div>
  );
}

export default function Shell({ children }: { children: React.ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [lk, setLk] = useState<any>(null);
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
  useEffect(() => { if (appHome && !appAllowed) router.replace(appHome); }, [appHome, appAllowed]);  // eslint-disable-line react-hooks/exhaustive-deps
  if (!me || !lk || !appAllowed) return <div className="boot"><img src="/brand/mark.png" alt="" width={44} height={40} /><span className="muted">Loading…</span></div>;
  const can = (p: string) => me.permissions.includes(p);
  const logout = async () => { await api('/api/auth/logout', { body: {} }); location.href = '/login'; };
  const ctx = { me, can, lk, reloadLookups: () => api('/api/lookups').then(setLk) };
  if (appHome) return (
    // Phone app for drivers and messengers: no sidebar, big touch targets, only their own work.
    <MeCtx.Provider value={ctx}>
      <div className="app-shell">
        <header className="app-top">
          <Link href={appHome} className="app-brand"><img src="/brand/mark-on-dark.png" alt="" width={30} height={28} />
            <span>{appHome === '/my-jobs' ? 'My jobs' : appHome === '/pro' ? 'My PRO work' : 'My runs'}</span></Link>
          <span className="spacer" />
          <Bell compact jobHref={(id) => `/my-jobs/${id}`} />
          <button className="btn small" onClick={() => confirm('Sign out of the app?') && logout()}>Sign out</button>
        </header>
        <main className="app-main">{children}</main>
        <footer className="app-foot muted small">{me.full_name} · Reliance Freight Systems</footer>
      </div>
    </MeCtx.Provider>
  );
  return (
    <MeCtx.Provider value={ctx}>
      <Suspense fallback={<div className="boot"><span className="muted">Loading…</span></div>}>
        <Frame me={me} lk={lk} can={can}>{children}</Frame>
      </Suspense>
    </MeCtx.Provider>
  );
}
