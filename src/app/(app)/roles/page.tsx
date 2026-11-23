'use client';
import { Fragment, useEffect, useState } from 'react';
import { api } from '@/components/api';
import { useMe } from '@/components/Shell';

const ACTIONS: [string, string][] = [['view', 'View'], ['create', 'Create'], ['edit', 'Edit'], ['delete', 'Delete'], ['approve', 'Approve'], ['manage', 'Manage'], ['export', 'Export']];
/** "jobfiles.view_department" → "department", "finance.selling.view" → "selling", "quotes.view" → "" (the column says it all). */
const short = (code: string, action: string) => code.split('.').slice(1).join(' ').replace(new RegExp(`^${action}_?|[ _]?${action}$`), '')
  .replace(/^(view|manage|create|edit|approve)_/, '').replace(/[._]/g, ' ').trim();
const SIDES: [string, string][] = [['operations', 'Operations'], ['transport', 'Transport'], ['messenger', 'Messengers'], ['pro', 'PRO'], ['warehouse', 'Warehouse'], ['finance', 'Finance'], ['admin', 'Administration']];

export default function Roles() {
  const { can } = useMe();
  const [data, setData] = useState<any>(null);
  const [draft, setDraft] = useState<Record<string, Set<string>>>({});
  const [side, setSide] = useState('operations');
  const [adding, setAdding] = useState<{ name: string; side: string; copy_from?: string } | null>(null);
  const [view, setView] = useState<'one' | 'compare'>('one');
  const [pick, setPick] = useState('');
  const [gives, setGives] = useState<Set<string> | null>(null);
  const [msg, setMsg] = useState<{ t: string; m: string } | null>(null);
  const load = () => api('/api/roles').then((d) => {
    setData(d); setDraft(Object.fromEntries(d.roles.map((r: any) => [r.id, new Set(r.permissions)])));
  }).catch((e) => setMsg({ t: 'err', m: e.message }));
  useEffect(() => { load(); }, []);
  if (!can('roles.manage') && !can('roles.manage_department')) return <div className="page"><div className="msg err">You don't have permission to manage roles.</div></div>;
  if (!data) return <div className="page muted">{msg ? <div className="msg err">{msg.m}</div> : 'Loading…'}</div>;
  const all = data.scope === 'all';
  const shown = all ? data.roles.filter((r: any) => r.side === side || (side === 'admin' && !r.side)) : data.roles;
  const toggle = (rid: string, code: string) => { const s = new Set(draft[rid]); s.has(code) ? s.delete(code) : s.add(code); setDraft({ ...draft, [rid]: s }); };
  const dirty = (r: any) => r.editable && [...draft[r.id]].sort().join() !== [...r.permissions].sort().join();
  const save = async (r: any) => {
    try { await api(`/api/roles/${r.id}`, { method: 'PUT', body: { permissions: [...draft[r.id]] } });
      setMsg({ t: 'ok', m: `${r.name} saved. Its ${r.user_count} user(s) will be asked to sign in again.` }); load();
    } catch (e: any) { setMsg({ t: 'err', m: e.message }); }
  };
  const add = async () => {
    try { const r = await api('/api/roles', { body: { ...adding, copy_from: adding!.copy_from || undefined } }); setAdding(null); setMsg({ t: 'ok', m: `Role "${adding!.name}" added. Tick its permissions and save.` }); setPick(r.id); setView('one'); load(); }
    catch (e: any) { setMsg({ t: 'err', m: e.message }); }
  };
  const cur = shown.find((r: any) => r.id === pick) ?? shown[0];
  const curGives = (r: any) => new Set<string>(data.assignable.filter((a: any) => a.role_id === r.id).map((a: any) => a.assignable_role_id));
  const giveable = (r: any) => data.roles.filter((x: any) => !x.is_manager && x.code !== 'super_admin' && x.side === r.side && !x.department_id);
  const saveGives = async (r: any) => {
    try { await api(`/api/roles/${r.id}/assignable`, { method: 'PUT', body: { roles: [...(gives ?? curGives(r))] } });
      setMsg({ t: 'ok', m: `Saved: the roles a ${r.name} can give.` }); setGives(null); load();
    } catch (e: any) { setMsg({ t: 'err', m: e.message }); }
  };
  // where one module mixes areas (Administration: audit, users, roles…), say which area each tick is for
  const prefixes = (m: string) => new Set(data.permissions.filter((p: any) => p.module === m).map((p: any) => p.code.split('.')[0]));
  const label = (p: any, a: string) => { const w = short(p.code, a); const area = p.code.split('.')[0];
    return prefixes(p.module).size > 1 ? `${area}${w ? ' ' + w : ''}` : (w || 'yes'); };
  const blocked = (r: any, p: any) => p.sensitivity === 'commercial' && (['transport', 'messenger', 'pro', 'warehouse'].includes(r.side) || r.app_only);
  const modules = [...new Set(data.permissions.map((p: any) => p.module))] as string[];
  return (
    <div className="page">
      <div className="page-head"><h1>{all ? 'Roles & permissions' : `Roles — ${data.department.name}`}</h1><span className="spacer" />
        {all && <select value={side} onChange={(e) => setSide(e.target.value)} style={{ width: 170 }} aria-label="Side">
          {SIDES.map(([k, l]) => <option key={k} value={k}>{l} roles</option>)}</select>}
        <button className="btn" onClick={() => setAdding({ name: '', side: all ? side : data.department.side })}>Add role</button></div>
      {!all && <p className="muted small" style={{ marginTop: -6 }}>Roles you add here are only for {data.department.name}. You can give a role only the permissions you have yourself. Shared roles are shown for reference and can only be changed by the Super Admin.</p>}
      {msg && <div className={`msg ${msg.t}`}>{msg.m}</div>}
      <div className="msg warn">Selling price, revenue, profit and customer documents can never reach Transport or Messenger users, whatever is ticked. Profit is only shown to someone who can see both the selling price and the cost.</div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={view === 'one'} className={view === 'one' ? 'on' : ''} onClick={() => setView('one')}>One role</button>
        <button role="tab" aria-selected={view === 'compare'} className={view === 'compare' ? 'on' : ''} onClick={() => setView('compare')}>Compare roles</button>
      </div>
      {view === 'one' && cur && <div className="role-layout">
        <nav className="role-list" aria-label="Roles">{shown.map((r: any) => (
          <button key={r.id} className={r.id === cur.id ? 'on' : ''} onClick={() => { setPick(r.id); setGives(null); }}>
            <b>{r.name}</b><span className="muted small">{r.department_name ?? (r.is_manager ? 'Department admin' : 'Shared')} · {r.user_count} user(s){dirty(r) ? ' · not saved' : ''}</span></button>))}</nav>
        <div className="panel" style={{ minWidth: 0 }}>
          <div className="role-head"><h2>{cur.name}</h2><span className="spacer" />
            {dirty(cur) && <button className="btn" onClick={() => setDraft({ ...draft, [cur.id]: new Set(cur.permissions) })}>Undo</button>}
            {dirty(cur) && <button className="btn primary" onClick={() => save(cur)}>Save</button>}</div>
          <p className="muted small">{cur.code === 'super_admin' ? 'The Super Admin always has everything.' : !cur.editable ? 'Shown for reference — only the Super Admin can change this role.'
            : 'Tick what this role may do. Under View, the words say how much they see: all, department, team, assigned (their own).'}</p>
          <div className="table-wrap"><table className="t grid-perms">
            <thead><tr><th>Module</th>{ACTIONS.map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
            <tbody>{modules.map((m) => (
              <tr key={m}><td><b>{m}</b></td>{ACTIONS.map(([a]) => <td key={a}>{data.permissions.filter((p: any) => p.module === m && p.action === a).map((p: any) => (
                <label key={p.code} className="perm-chip" title={blocked(cur, p) ? `${p.name} — never available on this side` : p.name}>
                  <input type="checkbox" aria-label={`${cur.name}: ${p.name}`} disabled={!cur.editable || blocked(cur, p)}
                    checked={cur.code === 'super_admin' || (!blocked(cur, p) && !!draft[cur.id]?.has(p.code))} onChange={() => toggle(cur.id, p.code)} />
                  <span>{label(p, a)}{p.sensitivity === 'commercial' && <span className="sens">conf.</span>}</span></label>))}</td>)}</tr>))}
            </tbody></table></div>
          {all && cur.is_manager && <div style={{ marginTop: 18 }}>
            <h2>Roles a {cur.name} can give</h2>
            <p className="muted small" style={{ marginTop: 0 }}>When none is ticked, they can give every shared {cur.side} role, as before. Roles made for their own department can always be given.</p>
            <div className="perm-gives">{giveable(cur).map((x: any) => {
              const set = gives ?? curGives(cur);
              return <label key={x.id} className="perm-chip"><input type="checkbox" checked={set.has(x.id)} onChange={() => { const n = new Set(set); n.has(x.id) ? n.delete(x.id) : n.add(x.id); setGives(n); }} /><span>{x.name}</span></label>;
            })}</div>
            {gives && <div className="actions" style={{ justifyContent: 'flex-start' }}><button className="btn" onClick={() => setGives(null)}>Undo</button><button className="btn primary" onClick={() => saveGives(cur)}>Save</button></div>}
          </div>}
        </div>
      </div>}
      {view === 'compare' && <div className="panel flush"><div className="table-wrap"><table className="t perm-matrix">
        <thead><tr><th>Permission</th>{shown.map((r: any) => <th key={r.id}>{r.name}
          <div className="muted small">{r.department_name ?? (r.is_manager ? 'Department admin' : 'Shared')} · {r.user_count} user(s)</div></th>)}</tr></thead>
        <tbody>
          {modules.map((m) => <Fragment key={m}>
            <tr><td colSpan={shown.length + 1} style={{ background: 'var(--surface-3)', fontWeight: 600 }}>{m}</td></tr>
            {data.permissions.filter((p: any) => p.module === m).map((p: any) => (
              <tr key={p.code}><td>{p.name}{p.sensitivity === 'commercial' && <span className="sens">confidential</span>}</td>
                {shown.map((r: any) => <td key={r.id}><input type="checkbox" aria-label={`${r.name}: ${p.name}`}
                  disabled={!r.editable || blocked(r, p)} title={blocked(r, p) ? 'Never available on this side' : undefined}
                  checked={r.code === 'super_admin' || (!blocked(r, p) && !!draft[r.id]?.has(p.code))} onChange={() => toggle(r.id, p.code)} /></td>)}</tr>))}
          </Fragment>)}
          <tr><td />{shown.map((r: any) => <td key={r.id}>{dirty(r) && <button className="btn small primary" onClick={() => save(r)}>Save</button>}</td>)}</tr>
        </tbody></table></div></div>}
      {shown.length === 0 && <p className="muted">No roles here yet.</p>}
      {adding && <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setAdding(null)}>
        <div className="modal" role="dialog" aria-label="Add role">
          <h2>Add role{!all && ` for ${data.department.name}`}</h2>
          <div className="grid g2">
            <label className="f span2"><span>Role name</span><input autoFocus value={adding.name} onChange={(e) => setAdding({ ...adding, name: e.target.value })} placeholder="e.g. Senior Clerk" /></label>
            <label className="f span2"><span>Start from</span><select value={adding.copy_from ?? ''} onChange={(e) => setAdding({ ...adding, copy_from: e.target.value })}>
              <option value="">Nothing ticked</option>
              {data.roles.filter((r: any) => r.code !== 'super_admin').map((r: any) => <option key={r.id} value={r.id}>Copy of {r.name}</option>)}</select></label>
            {all && <label className="f span2"><span>For which side</span><select value={adding.side} onChange={(e) => setAdding({ ...adding, side: e.target.value })}>
              {SIDES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
              <span className="muted small" style={{ fontWeight: 400, marginTop: 4 }}>Managers on that side can then give this role to their staff.</span></label>}
          </div>
          <div className="actions"><button className="btn" onClick={() => setAdding(null)}>Cancel</button>
            <button className="btn primary" disabled={!adding.name.trim()} onClick={add}>Add role</button></div>
        </div></div>}
    </div>
  );
}
