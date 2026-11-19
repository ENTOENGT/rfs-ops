'use client';
import SendAppLink from '@/components/SendAppLink';
import { useEffect, useMemo, useState } from 'react';
import { api, fmtDateTime } from '@/components/api';
import { useMe } from '@/components/Shell';
import { StatusDot } from '@/components/Presence';

const SIDE: Record<string, string> = { admin: 'Administration', operations: 'Operations', transport: 'Transport', messenger: 'Messengers', finance: 'Finance', pro: 'PRO', warehouse: 'Warehouse' };

function UserForm({ user, data, onDone, onClose }: { user?: any; data: any; onDone: (msg: string, sendApp?: any) => void; onClose: () => void }) {
  const all = data.scope === 'all';
  const [f, setF] = useState<any>(user ? { ...user } : {
    full_name: '', email: '', mobile: '', role_id: '', department_id: all ? '' : data.department.id, designation_id: '', manager_id: '', overrides: [] });
  const [err, setErr] = useState('');
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value, ...(k === 'department_id' ? { role_id: '' } : {}) });
  const dept = data.departments.find((d: any) => d.id === f.department_id);
  // Only roles that fit the chosen department (same side, and either shared or this department's own)
  const roles = data.roles.filter((r: any) => dept && (r.code === 'super_admin' ? dept.side === 'admin'
    : (!r.side || r.side === dept.side) && (!r.department_id || r.department_id === dept.id))
    // drivers are added on the Drivers page (so jobs can be assigned to them), then sent the app from there
    && (r.code !== 'driver' || user?.role_code === 'driver'));
  const appRole = !!data.roles.find((r: any) => r.id === f.role_id)?.app_only;
  // Part E: Commercials roles carry a division; a Salesman has a dedicated Coordinator
  const roleCode = data.roles.find((r: any) => r.id === f.role_id)?.code;
  const commercial = ['sales', 'coordinator', 'agent_coordinator', 'commercials_manager'].includes(roleCode);
  const coordChanged = !!user && roleCode === 'sales' && (user.coordinator_id ?? '') !== (f.coordinator_id ?? '') && !!user.coordinator_id;
  // migration 025: who they report to and their title. A reason is asked when an existing reporting line changes.
  const mgrChanged = !!user && !!user.manager_id && (user.manager_id ?? '') !== (f.manager_id ?? '');
  const managers = (data.managers ?? []).filter((m: any) => m.id !== user?.id);
  const [history, setHistory] = useState<any[] | null>(null);
  const ov = (code: string) => f.overrides.find((o: any) => o.code === code);
  const setOv = (code: string, v: string) => setF({ ...f, overrides: [...f.overrides.filter((o: any) => o.code !== code),
    ...(v === '' ? [] : [{ code, granted: v === 'grant' }])] });
  // One simple choice for the setting managers change most: the selling price.
  const SELL = ['finance.selling.view', 'finance.profit.view', 'documents.view_commercial'], SELL_EDIT = 'finance.selling.edit';
  const showSell = dept?.side === 'operations' && data.permissions.some((p: any) => p.code === SELL_EDIT);
  const sell = ov(SELL[0])?.granted === false ? 'no' : ov(SELL[0])?.granted ? (ov(SELL_EDIT)?.granted ? 'edit' : 'view') : '';
  const setSell = (v: string) => {
    const codes = [...SELL, SELL_EDIT];
    const rest = f.overrides.filter((o: any) => !codes.includes(o.code));
    const add = v === 'view' ? SELL.map((code) => ({ code, granted: true }))
      : v === 'edit' ? codes.map((code) => ({ code, granted: true }))
      : v === 'no' ? codes.map((code) => ({ code, granted: false })) : [];
    setF({ ...f, overrides: [...rest, ...add] });
  };
  const save = async () => {
    try {
      if (user) {
        await api(`/api/users/${user.id}`, { method: 'PATCH', body: { full_name: f.full_name, mobile: f.mobile, role_id: f.role_id,
          ...(all ? { department_id: f.department_id } : {}), overrides: f.overrides,
          ...(commercial ? { division: f.division || null, coordinator_id: roleCode === 'sales' ? (f.coordinator_id || null) : undefined } : {}),
          designation_id: f.designation_id || null, ...((f.manager_id ?? '') !== (user.manager_id ?? '') ? { manager_id: f.manager_id || null } : {}),
          assignment_reason: f.assignment_reason } });
        onDone(`Changes saved for ${f.full_name}. They will be asked to sign in again if their access changed.`);
      } else {
        const r = await api('/api/users', { body: { ...f, designation_id: f.designation_id || null, ...(f.manager_id ? { manager_id: f.manager_id } : {}) } });
        if (appRole) onDone(`${f.full_name} added.`, { id: r.id, full_name: f.full_name });     // goes straight to "Send app link"
        else onDone(`${f.full_name} added. Temporary password: ${r.temporary_password} — give it to them privately. They choose their own password at first sign-in.`);
      }
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label={user ? 'Edit user' : 'Add user'}>
        <h2>{user ? `Edit ${user.full_name}` : all ? 'Add user' : `Add user to ${data.department.name}`}</h2>
        {err && <div className="msg err">{err}</div>}
        <div className="grid g2">
          <label className="f"><span>Full name <em>*</em></span><input value={f.full_name} onChange={set('full_name')} /></label>
          <label className="f"><span>Email {appRole ? <small className="muted">(optional)</small> : <em>*</em>}</span><input type="email" value={f.email} onChange={set('email')} disabled={!!user} /></label>
          <label className="f"><span>Mobile {appRole && <em>*</em>}</span><input value={f.mobile ?? ''} onChange={set('mobile')} placeholder={appRole ? 'They sign in to the phone app with this' : ''} /></label>
          {all ? <label className="f"><span>Department <em>*</em></span><select value={f.department_id ?? ''} onChange={set('department_id')}>
              <option value="">Choose department</option>
              {Object.keys(SIDE).map((side) => {
                const ds = data.departments.filter((d: any) => d.side === side);
                return ds.length ? <optgroup key={side} label={SIDE[side]}>{ds.map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</optgroup> : null;
              })}</select></label>
            : <label className="f"><span>Department</span><input value={data.department.name} disabled /></label>}
          <label className="f span2"><span>Role <em>*</em></span><select value={f.role_id} onChange={set('role_id')} disabled={all && !f.department_id}>
            <option value="">{all && !f.department_id ? 'Choose the department first' : 'Choose role'}</option>
            {roles.map((r: any) => <option key={r.id} value={r.id}>{r.name}{r.is_manager ? ' (department admin)' : ''}</option>)}</select></label>
          {commercial && <label className="f"><span>Division (optional — empty means every division)</span>
            <select value={f.division ?? ''} onChange={set('division')}><option value="">All divisions</option>
              {data.divisions.map(([k, n]: [string, string]) => <option key={k} value={k}>{n}</option>)}</select></label>}
          {roleCode === 'sales' && <label className="f"><span>Dedicated Coordinator</span>
            <select value={f.coordinator_id ?? ''} onChange={set('coordinator_id')}><option value="">Not assigned yet</option>
              {data.coordinators.map((c: any) => <option key={c.id} value={c.id}>{c.full_name}{c.division ? ` — ${data.divisions.find(([k]: [string]) => k === c.division)?.[1]}` : ''}</option>)}</select></label>}
          {coordChanged && <label className="f span2"><span>Reason for changing the Coordinator <em>*</em></span><input value={f.assignment_reason ?? ''} onChange={set('assignment_reason')} /></label>}
          <label className="f"><span>Designation</span><select value={f.designation_id ?? ''} onChange={set('designation_id')}>
            <option value="">No title yet</option>
            {(data.designations ?? []).map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
          <label className="f"><span>Reports to</span><select value={f.manager_id ?? ''} onChange={set('manager_id')}
              disabled={data.scope !== 'all' && !!user?.manager_id && !managers.some((m: any) => m.id === user.manager_id)}>
            <option value="">{data.scope === 'team' && !user ? 'Me' : 'Nobody yet'}</option>
            {managers.map((m: any) => <option key={m.id} value={m.id}>{m.full_name}{m.designation_name ? ` — ${m.designation_name}` : ''}{data.scope === 'all' && m.department_name ? ` (${m.department_name})` : ''}</option>)}</select></label>
          {mgrChanged && !coordChanged && <label className="f span2"><span>Reason for changing who they report to <em>*</em></span><input value={f.assignment_reason ?? ''} onChange={set('assignment_reason')} /></label>}
        </div>
        {user && <p className="small" style={{ marginTop: 6 }}>{history === null
          ? <button className="linkish" onClick={() => api(`/api/users/${user.id}/assignments`).then(setHistory).catch((e) => setErr(e.message))}>Show assignment history</button>
          : history.length === 0 ? <span className="muted">No changes to the reporting line, title, division or Coordinator yet.</span>
          : history.map((h, i) => <span key={i} style={{ display: 'block' }}>{new Date(h.at).toLocaleDateString('en-GB')} — {({ coordinator: 'Coordinator', division: 'Division', manager: 'Reports to', designation: 'Designation', role: 'Role', department: 'Department' } as Record<string, string>)[h.field] ?? h.field}: {h.old_label ?? 'none'} → {h.new_label ?? 'none'}
            {h.reason && <> ({h.reason})</>} · {h.changed_by_name}</span>)}</p>}
        {user && showSell && <label className="f" style={{ marginTop: 14 }}><span>Selling price, revenue and profit</span>
          <select value={sell} onChange={(e) => setSell(e.target.value)}>
            <option value="">As the role gives</option><option value="view">Can see them</option>
            <option value="edit">Can see them and enter the selling price</option><option value="no">Cannot see them</option></select></label>}
        {user && <>
          <h2 style={{ marginTop: 16 }}>Exceptions to the role</h2>
          <p className="muted small" style={{ marginTop: 0 }}>Leave on "From role" unless this person needs more or less than their role gives.
            {!all && ' You can only give permissions you have yourself.'}</p>
          <div style={{ maxHeight: 240, overflowY: 'auto', border: '1px solid var(--line)', borderRadius: 4 }}>
            <table className="t"><tbody>{data.permissions.map((p: any) => (
              <tr key={p.code}><td>{p.name}{p.sensitivity === 'commercial' && <span className="sens">confidential</span>}</td>
                <td style={{ width: 140 }}><select value={ov(p.code) ? (ov(p.code).granted ? 'grant' : 'revoke') : ''} onChange={(e) => setOv(p.code, e.target.value)}>
                  <option value="">From role</option><option value="grant">Always allow</option><option value="revoke">Never allow</option></select></td></tr>))}
            </tbody></table>
          </div>
          {dept && ['transport', 'messenger', 'pro', 'warehouse'].includes(dept.side) && <p className="muted small">Selling price, revenue and profit can never be given to anyone on the {SIDE[dept.side]} side.</p>}
        </>}
        <div className="actions"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>{user ? 'Save changes' : 'Add user'}</button></div>
      </div>
    </div>
  );
}

/** Organisation chart (migration 025): each person under who they report to; people with nobody above them and nobody below are "not placed yet". */
function OrgChart({ users, onEdit }: { users: any[]; onEdit: (u: any) => void }) {
  const [shut, setShut] = useState<Record<string, boolean>>({});
  const ids = new Set(users.map((u) => u.id));
  const kids = (id: string) => users.filter((u) => u.manager_id === id);
  const tops = users.filter((u) => !u.manager_id || !ids.has(u.manager_id));
  const roots = tops.filter((u) => kids(u.id).length > 0);
  const loose = tops.filter((u) => kids(u.id).length === 0);
  const Node = ({ u }: { u: any }): JSX.Element => {
    const k = kids(u.id);
    return (
      <li>
        <div className={`org-card${u.is_active ? '' : ' off'}`}>
          {k.length > 0 ? <button className="org-tog" aria-label={shut[u.id] ? 'Open' : 'Close'} onClick={() => setShut({ ...shut, [u.id]: !shut[u.id] })}>{shut[u.id] ? '+' : '−'}</button> : <span className="org-tog blank" />}
          <div className="org-who">
            <b><StatusDot s={u} /> {u.full_name}</b>
            <span className="muted small">{[u.designation_name, u.role_name, u.department_name].filter(Boolean).join(' · ')}</span>
          </div>
          {k.length > 0 && <span className="badge outline">{k.length}</span>}
          {!u.is_active && <span className="flag">Disabled</span>}
          {u.can_edit && <button className="btn small" onClick={() => onEdit(u)}>Edit</button>}
        </div>
        {k.length > 0 && !shut[u.id] && <ul>{k.map((c) => <Node key={c.id} u={c} />)}</ul>}
      </li>
    );
  };
  return (
    <div className="panel">
      {roots.length === 0 && loose.length === 0 && <p className="muted">Nobody to show.</p>}
      {roots.length > 0 && <ul className="org-tree">{roots.map((u) => <Node key={u.id} u={u} />)}</ul>}
      {loose.length > 0 && <>
        <h2 style={{ marginTop: roots.length ? 20 : 0 }}>Not placed yet <span className="muted small">— nobody above them and nobody below. Edit a person to set who they report to.</span></h2>
        <ul className="org-tree flat">{loose.map((u) => <Node key={u.id} u={u} />)}</ul>
      </>}
    </div>
  );
}

/** Job titles — Super Admin only. A title says what someone is called; the role decides what they can do. */
function Designations({ onMsg }: { onMsg: (m: { t: 'ok' | 'err'; m: string }) => void }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [f, setF] = useState<any>({ name: '', level: 50 });
  const load = () => api('/api/settings/designations').then(setRows).catch((e) => onMsg({ t: 'err', m: e.message }));
  useEffect(() => { load(); }, []);
  const save = async (b: any, ok: string) => {
    try { setRows(await api('/api/settings/designations', { body: b })); onMsg({ t: 'ok', m: ok }); if (!b.id) setF({ name: '', level: 50 }); }
    catch (e: any) { onMsg({ t: 'err', m: e.message }); }
  };
  if (!rows) return <p className="muted">Loading…</p>;
  return (
    <div className="panel">
      <p className="muted small" style={{ marginTop: 0 }}>A designation is the person's job title (Manager, Team Leader, Executive…). It does not give any access — the role does.
        The number only sorts the list: smaller = more senior.</p>
      <div className="row-form">
        <input placeholder="New designation, e.g. Branch Head" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} aria-label="Designation name" />
        <input type="number" min={1} max={99} style={{ width: 80 }} value={f.level} onChange={(e) => setF({ ...f, level: e.target.value })} aria-label="Order" />
        <button className="btn primary" disabled={!f.name.trim()} onClick={() => save(f, `${f.name} added`)}>Add</button>
      </div>
      <div className="table-wrap"><table className="t">
        <thead><tr><th>Designation</th><th>Order</th><th>People</th><th>Status</th><th /></tr></thead>
        <tbody>{rows.map((d) => (
          <tr key={d.id}>
            <td><b>{d.name}</b></td><td>{d.level}</td><td>{d.users}</td>
            <td>{d.is_active ? 'In use' : <span className="muted">Switched off</span>}</td>
            <td style={{ whiteSpace: 'nowrap' }}>
              <button className="btn small" onClick={() => { const n = prompt('Rename designation', d.name); if (n && n.trim() && n.trim() !== d.name) save({ id: d.id, name: n.trim(), level: d.level }, 'Renamed'); }}>Rename</button>{' '}
              <button className="btn small" onClick={() => save({ id: d.id, name: d.name, level: d.level, is_active: !d.is_active }, `${d.name} ${d.is_active ? 'switched off' : 'switched on'}`)}>{d.is_active ? 'Switch off' : 'Switch on'}</button>
            </td>
          </tr>))}</tbody>
      </table></div>
    </div>
  );
}

/** Migration 026: who gets new jobs in each team — set once, not on every job. A customer's own handler comes first. */
function DefaultHandlers({ onMsg }: { onMsg: (m: { t: 'ok' | 'err'; m: string }) => void }) {
  const { lk } = useMe();
  const [d, setD] = useState<any>(null);
  const [f, setF] = useState<any>({ department_id: '', customer_id: '', user_id: '' });
  const load = () => api('/api/settings/default-handlers').then((x) => { setD(x); setF((o: any) => ({ ...o, department_id: o.department_id || (x.departments.length === 1 ? x.departments[0].id : '') })); })
    .catch((e) => onMsg({ t: 'err', m: e.message }));
  useEffect(() => { load(); }, []);
  if (!d) return <p className="muted">Loading…</p>;
  const save = async () => {
    try { await api('/api/settings/default-handlers', { body: f }); onMsg({ t: 'ok', m: 'Default handler saved.' }); setF({ ...f, customer_id: '', user_id: '' }); load(); }
    catch (e: any) { onMsg({ t: 'err', m: e.message }); }
  };
  const remove = async (r: any) => {
    if (!confirm(`Remove ${r.user_name} as default handler for ${r.customer_name ?? 'all customers'}?`)) return;
    try { await api(`/api/settings/default-handlers/${r.id}`, { method: 'DELETE' }); onMsg({ t: 'ok', m: 'Removed.' }); load(); } catch (e: any) { onMsg({ t: 'err', m: e.message }); }
  };
  const people = d.people.filter((u: any) => u.department_id === f.department_id);
  return (
    <div className="panel">
      <p className="muted small" style={{ marginTop: 0 }}>When a job arrives in a team it goes straight to that team's handler for the customer, else the team's handler for all customers.
        If none is set, the team's manager is told to choose. The manager can always change the handler on the job.</p>
      <div className="row-form">
        {d.departments.length > 1 && <select value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value, user_id: '' })} aria-label="Team">
          <option value="">Team…</option>{d.departments.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>}
        <select value={f.customer_id} onChange={(e) => setF({ ...f, customer_id: e.target.value })} aria-label="Customer">
          <option value="">All customers</option>{(lk.customers ?? []).map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        <select value={f.user_id} onChange={(e) => setF({ ...f, user_id: e.target.value })} aria-label="Handler" disabled={!f.department_id}>
          <option value="">Handler…</option>{people.map((u: any) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select>
        <button className="btn primary" disabled={!f.department_id || !f.user_id} onClick={save}>Save</button>
      </div>
      <div className="table-wrap"><table className="t">
        <thead><tr><th>Team</th><th>Customer</th><th>Handler</th><th /></tr></thead>
        <tbody>{d.rows.map((r: any) => (
          <tr key={r.id}><td>{r.department_name}</td><td>{r.customer_name ?? <b>All customers</b>}</td>
            <td>{r.user_name}{!r.valid && <div className="flag">Disabled or moved — choose someone else</div>}</td>
            <td><button className="btn small danger" onClick={() => remove(r)}>Remove</button></td></tr>))}
          {d.rows.length === 0 && <tr><td colSpan={4} className="muted" style={{ padding: 20, textAlign: 'center' }}>No default handlers yet — new jobs wait for the manager to choose.</td></tr>}
        </tbody></table></div>
    </div>
  );
}

/** Migration 026: which Operations team gets each kind of shipment at handover (the Super Admin changes it). */
const DIRS: [string, string][] = [['import', 'Import'], ['export', 'Export'], ['cross_trade', 'Cross trade'], ['domestic', 'Domestic']];
const MODE_NAMES: [string, string][] = [['', 'Any mode'], ['sea_fcl', 'Sea FCL'], ['sea_lcl', 'Sea LCL'], ['air', 'Air'], ['road', 'Road / land'], ['courier', 'Courier'], ['other', 'Others']];
function Routes({ onMsg }: { onMsg: (m: { t: 'ok' | 'err'; m: string }) => void }) {
  const [d, setD] = useState<any>(null);
  const [f, setF] = useState<any>({ direction: 'import', mode: '', department_id: '' });
  useEffect(() => { api('/api/settings/handover-routes').then(setD).catch(() => setD(null)); }, []);
  if (!d) return null;
  const save = async (b: any) => {
    try { setD(await api('/api/settings/handover-routes', { body: b })); onMsg({ t: 'ok', m: 'Handover route saved.' }); } catch (e: any) { onMsg({ t: 'err', m: e.message }); }
  };
  const nm = (list: [string, string][], k: string | null) => list.find(([x]) => x === (k ?? ''))?.[1] ?? k;
  return (
    <div className="panel" style={{ marginTop: 14 }}>
      <h2 style={{ marginTop: 0 }}>Which team gets each shipment at handover</h2>
      <p className="muted small" style={{ marginTop: 0 }}>The exact direction and mode is used first, then the direction's "any mode" line. The job then goes to that team's default handler above.</p>
      {d.editable && <div className="row-form">
        <select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })} aria-label="Direction">{DIRS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })} aria-label="Mode">{MODE_NAMES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <select value={f.department_id} onChange={(e) => setF({ ...f, department_id: e.target.value })} aria-label="Team"><option value="">Team…</option>
          {d.departments.map((x: any) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
        <button className="btn primary" disabled={!f.department_id} onClick={() => save(f)}>Save</button>
      </div>}
      <div className="table-wrap"><table className="t">
        <thead><tr><th>Direction</th><th>Mode</th><th>Goes to</th></tr></thead>
        <tbody>{d.rows.map((r: any) => <tr key={r.id}><td>{nm(DIRS, r.direction)}</td><td>{nm(MODE_NAMES, r.mode)}</td><td><b>{r.department_name}</b></td></tr>)}</tbody>
      </table></div>
    </div>
  );
}

export default function Users() {
  const { me, can } = useMe();
  const [data, setData] = useState<any>(null);
  const [edit, setEdit] = useState<any>(null);
  const [tab, setTab] = useState<'list' | 'chart' | 'titles' | 'handlers'>('list');
  const [q, setQ] = useState('');
  const [fl, setFl] = useState({ dept: '', role: '', status: 'active', mgr: '' });
  const [msg, setMsg] = useState<{ t: 'ok' | 'err'; m: string } | null>(null);
  const [appFor, setAppFor] = useState<any>(null);
  const load = () => api('/api/users').then(setData).catch((e) => setMsg({ t: 'err', m: e.message }));
  useEffect(() => { load(); const t = new URLSearchParams(window.location.search).get('tab'); if (t === 'chart' || t === 'titles' || t === 'handlers') setTab(t); }, []);
  const rows = useMemo(() => (data?.users ?? []).filter((u: any) =>
    (!q || `${u.full_name} ${u.email} ${u.department_name} ${u.role_name} ${u.designation_name ?? ''} ${u.manager_name ?? ''}`.toLowerCase().includes(q.toLowerCase()))
    && (!fl.dept || u.department_id === fl.dept) && (!fl.role || u.role_id === fl.role)
    && (fl.status === 'all' || (fl.status === 'active') === !!u.is_active)
    && (!fl.mgr || (fl.mgr === 'none' ? !u.manager_id : u.manager_id === fl.mgr))), [data, q, fl]);
  if (!can('users.manage') && !can('users.manage_department') && !can('users.manage_team'))
    return <div className="page"><div className="msg err">You don't have permission to manage people.</div></div>;
  if (!data) return <div className="page muted">{msg ? <div className="msg err">{msg.m}</div> : 'Loading…'}</div>;
  const act = async (fn: () => Promise<any>, ok: (r: any) => string) => {
    try { const r = await fn(); setMsg({ t: 'ok', m: ok(r) }); load(); } catch (e: any) { setMsg({ t: 'err', m: e.message }); }
    window.scrollTo(0, 0);
  };
  const disable = (u: any) => {
    const up = u.manager_name ? `They will now report to ${u.manager_name}.` : 'They will be shown as "not placed yet".';
    if (u.is_active && !confirm(`Disable ${u.full_name}?${u.reports_count ? `\n\n${u.reports_count} person(s) report to ${u.full_name}. ${up}` : ''}`)) return;
    act(() => api(`/api/users/${u.id}`, { method: 'PATCH', body: { is_active: !u.is_active } }), () => `${u.full_name} ${u.is_active ? 'disabled' : 'enabled'}`);
  };
  const title = data.scope === 'all' ? 'People' : data.scope === 'team' ? 'My team' : `People — ${data.department.name}`;
  const roleList = [...new Map((data.users ?? []).map((u: any) => [u.role_id, u.role_name])).entries()].sort((a: any, b: any) => a[1].localeCompare(b[1]));
  const deptList = [...new Map((data.users ?? []).filter((u: any) => u.department_id).map((u: any) => [u.department_id, u.department_name])).entries()].sort((a: any, b: any) => a[1].localeCompare(b[1]));
  const bosses = (data.users ?? []).filter((u: any) => u.reports_count > 0);
  const chartUsers = (data.users ?? []).filter((u: any) => (fl.status === 'all' || (fl.status === 'active') === !!u.is_active) && (!fl.dept || u.department_id === fl.dept));
  return (
    <div className="page">
      <div className="page-head"><h1>{title}</h1><span className="spacer" />
        <button className="btn primary" onClick={() => setEdit({})}>Add person</button></div>
      {data.scope === 'department' && <p className="muted small" style={{ marginTop: -6 }}>You manage the people of {data.department.name}. Managers are added and changed by the Super Admin.</p>}
      {data.scope === 'team' && <p className="muted small" style={{ marginTop: -6 }}>You manage the people who report to you, at any level. New people you add report to you.</p>}
      {msg && <div className={`msg ${msg.t}`}>{msg.m}</div>}
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'list'} className={tab === 'list' ? 'on' : ''} onClick={() => setTab('list')}>People</button>
        <button role="tab" aria-selected={tab === 'chart'} className={tab === 'chart' ? 'on' : ''} onClick={() => setTab('chart')}>Organisation chart</button>
        {(can('users.manage') || can('users.manage_department')) && <button role="tab" aria-selected={tab === 'handlers'} className={tab === 'handlers' ? 'on' : ''} onClick={() => setTab('handlers')}>Default handlers</button>}
        {can('users.manage') && <button role="tab" aria-selected={tab === 'titles'} className={tab === 'titles' ? 'on' : ''} onClick={() => setTab('titles')}>Designations</button>}
      </div>
      {tab === 'handlers' && <><DefaultHandlers onMsg={(m) => setMsg(m)} /><Routes onMsg={(m) => setMsg(m)} /></>}
      {tab !== 'titles' && tab !== 'handlers' && <div className="filter-row">
        {tab === 'list' && <input style={{ width: 220 }} placeholder="Search name, email, title…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search people" />}
        {data.scope === 'all' && <select value={fl.dept} onChange={(e) => setFl({ ...fl, dept: e.target.value })} aria-label="Department">
          <option value="">All departments</option>{deptList.map(([id, n]: any) => <option key={id} value={id}>{n}</option>)}</select>}
        {tab === 'list' && <select value={fl.role} onChange={(e) => setFl({ ...fl, role: e.target.value })} aria-label="Role">
          <option value="">All roles</option>{roleList.map(([id, n]: any) => <option key={id} value={id}>{n}</option>)}</select>}
        {tab === 'list' && <select value={fl.mgr} onChange={(e) => setFl({ ...fl, mgr: e.target.value })} aria-label="Reports to">
          <option value="">Anyone's team</option><option value="none">Reports to nobody</option>
          {bosses.map((u: any) => <option key={u.id} value={u.id}>Reports to {u.full_name}</option>)}</select>}
        <select value={fl.status} onChange={(e) => setFl({ ...fl, status: e.target.value })} aria-label="Status">
          <option value="active">Active</option><option value="disabled">Disabled</option><option value="all">Active and disabled</option></select>
        {tab === 'list' && <span className="muted small">{rows.length} {rows.length === 1 ? 'person' : 'people'}</span>}
      </div>}
      {tab === 'chart' && <OrgChart users={chartUsers} onEdit={setEdit} />}
      {tab === 'titles' && <Designations onMsg={(m) => setMsg(m)} />}
      {tab === 'list' && <div className="panel flush"><div className="table-wrap"><table className="t">
        <thead><tr><th>Name</th><th>Email / mobile</th><th>Department</th><th>Role</th><th>Reports to</th><th>Division / Coordinator</th><th>Exceptions</th><th>Last sign-in</th><th>Status</th><th /></tr></thead>
        <tbody>{rows.map((u: any) => (
          <tr key={u.id}>
            <td><b><StatusDot s={u} /> {u.full_name}</b>{u.designation_name && <div className="muted small">{u.designation_name}</div>}{u.app_only && <div className="muted small">Phone app</div>}</td>
            <td>{u.app_only && u.mobile ? u.mobile : u.email}</td>
            <td>{u.department_name ?? <span className="flag">No department</span>}{u.department_name && u.department_active === false && <div className="flag">Department retired — move this user</div>}</td>
            <td>{u.role_name}{u.is_manager && <span className="badge outline" style={{ marginLeft: 6 }}>Manager</span>}{u.role_retired && <div className="flag">Role retired — give this user a new role</div>}</td>
            <td className="small">{u.manager_name ?? <span className="muted">—</span>}{u.reports_count > 0 && <div className="muted">{u.reports_count} report{u.reports_count === 1 ? 's' : ''} to them</div>}</td>
            <td className="small">{data.divisions.find(([k]: [string]) => k === u.division)?.[1] ?? ''}{u.coordinator_name && <div>Coordinator: {u.coordinator_name}</div>}
              {u.salesmen_count > 0 && <div className="muted">{u.salesmen_count} Salesm{u.salesmen_count === 1 ? 'an' : 'en'}</div>}</td>
            <td>{u.overrides.length ? <span className="flag">{u.overrides.length}</span> : '—'}</td>
            <td>{fmtDateTime(u.last_login_at)}</td>
            <td>{u.is_active ? (u.must_change_password ? <span className="badge outline">{u.app_only ? 'App not set up yet' : 'Awaiting first sign-in'}</span> : 'Active') : <span className="badge" style={{ background: '#9B2C2C' }}>Disabled</span>}</td>
            <td style={{ whiteSpace: 'nowrap' }}>{u.can_edit && <>
              <button className="btn small" onClick={() => setEdit(u)}>Edit</button>{' '}
              {u.app_only
                ? u.is_active && <><button className="btn small" onClick={() => setAppFor(u)}>Send app link</button>{' '}</>
                : <><button className="btn small" onClick={() => confirm(`Reset password for ${u.full_name}?`) && act(() => api(`/api/users/${u.id}/reset-password`, { body: {} }), (r) => `Temporary password for ${u.full_name}: ${r.temporary_password}`)}>Reset password</button>{' '}</>}
              {u.id !== me.id && <button className="btn small danger" onClick={() => disable(u)}>{u.is_active ? 'Disable' : 'Enable'}</button>}
            </>}</td>
          </tr>))}
          {rows.length === 0 && <tr><td colSpan={10} className="muted" style={{ padding: 24, textAlign: 'center' }}>{q || fl.dept || fl.role || fl.mgr ? 'Nobody matches these filters.' : 'No people yet.'}</td></tr>}
        </tbody></table></div></div>}
      {appFor && <SendAppLink userId={appFor.id} name={appFor.full_name} onClose={() => { setAppFor(null); load(); }} />}
      {edit && <UserForm user={edit.id ? edit : undefined} data={data} onClose={() => setEdit(null)} onDone={(m, app) => { setEdit(null); setMsg({ t: 'ok', m }); load(); if (app) setAppFor(app); }} />}
    </div>
  );
}
