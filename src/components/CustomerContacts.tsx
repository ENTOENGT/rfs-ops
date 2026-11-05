'use client';
import { useEffect, useState } from 'react';
import { api } from './api';

/** Which Salesmen own the customer (Part E). The Commercials Manager changes it; everyone else sees it. */
function Owners({ customerId }: { customerId: string }) {
  const [o, setO] = useState<any>(null);
  const [edit, setEdit] = useState<any[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api(`/api/customers/${customerId}/owners`).then(setO).catch((e) => setErr(e.message)); }, [customerId]);
  const save = async () => {
    setErr('');
    try { setO(await api(`/api/customers/${customerId}/owners`, { method: 'PUT', body: { owners: edit } })); setEdit(null); } catch (e: any) { setErr(e.message); }
  };
  if (!o) return err ? <div className="msg err">{err}</div> : null;
  return <div style={{ marginTop: 14 }}>
    <h3 className="small" style={{ margin: '0 0 6px' }}>Salesmen</h3>
    {err && <div className="msg err">{err}</div>}
    {!edit && <p className="small" style={{ margin: 0 }}>{o.owners.length ? o.owners.map((x: any) => `${x.full_name}${x.is_main ? ' (main)' : ''}`).join(', ')
      : 'Nobody yet — the first Salesman to open an enquiry for this customer becomes the main owner.'}
      {o.can_manage && <> <button className="linkish" onClick={() => setEdit(o.owners.map((x: any) => ({ user_id: x.user_id, is_main: x.is_main })))}>Change</button></>}</p>}
    {edit && <>
      {edit.map((x, i) => <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 6 }}>
        <select value={x.user_id} onChange={(e) => setEdit(edit.map((y, j) => j === i ? { ...y, user_id: e.target.value } : y))} style={{ flex: 1 }}>
          <option value="">Choose Salesman</option>{o.salesmen.map((u: any) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select>
        <label className="check"><input type="radio" name="main_owner" checked={x.is_main} onChange={() => setEdit(edit.map((y, j) => ({ ...y, is_main: j === i })))} /> Main</label>
        <button className="btn small" onClick={() => setEdit(edit.filter((_, j) => j !== i))}>✕</button></div>)}
      <div style={{ display: 'flex', gap: 6 }}><button className="btn small" onClick={() => setEdit([...edit, { user_id: '', is_main: edit.length === 0 }])}>+ Add Salesman</button>
        <span className="spacer" /><button className="btn small" onClick={() => setEdit(null)}>Cancel</button>
        <button className="btn small primary" disabled={edit.some((x) => !x.user_id)} onClick={save}>Save Salesmen</button></div>
    </>}
  </div>;
}

/** Several contacts per customer (operations, accounts, escalation…). Opened from the Customers list. */
export default function CustomerContacts({ customerId, onClose }: { customerId: string; onClose: () => void }) {
  const [d, setD] = useState<any>(null);
  const [f, setF] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api(`/api/customers/${customerId}/contacts`).then(setD).catch((e) => setErr(e.message)); }, [customerId]);
  const save = async (body: any) => {
    setErr('');
    try { setD(await api(`/api/customers/${customerId}/contacts`, { body })); setF(null); } catch (e: any) { setErr(e.message); }
  };
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Customer contacts" style={{ maxWidth: 720 }}>
        <h2>Contacts — {d?.customer.name ?? '…'}</h2>
        {err && <div className="msg err">{err}</div>}
        {d && <div className="table-wrap"><table className="t">
          <thead><tr><th>Name</th><th>Role</th><th>Mobile</th><th>Email</th>{d.can_edit && <th />}</tr></thead>
          <tbody>{d.contacts.map((c: any) => <tr key={c.id}>
            <td><b>{c.full_name}</b>{c.is_primary && <span className="badge outline" style={{ marginLeft: 6 }}>Main</span>}{c.remarks && <div className="muted small">{c.remarks}</div>}</td>
            <td>{c.role ?? '—'}</td><td>{c.mobile ?? '—'}</td><td>{c.email ?? '—'}</td>
            {d.can_edit && <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}><button className="btn small" onClick={() => setF({ ...c })}>Edit</button>{' '}
              <button className="btn small danger" onClick={() => confirm(`Remove ${c.full_name}?`) && save({ id: c.id, remove: true })}>Remove</button></td>}
          </tr>)}
            {d.contacts.length === 0 && <tr><td colSpan={5} className="muted">No contacts yet.</td></tr>}</tbody></table></div>}
        {f && <div className="grid g2" style={{ marginTop: 12 }}>
          <label className="f"><span>Name</span><input autoFocus value={f.full_name ?? ''} onChange={set('full_name')} /></label>
          <label className="f"><span>Role</span><input value={f.role ?? ''} onChange={set('role')} placeholder="Operations, Accounts, Escalation…" /></label>
          <label className="f"><span>Mobile</span><input value={f.mobile ?? ''} onChange={set('mobile')} /></label>
          <label className="f"><span>Email</span><input value={f.email ?? ''} onChange={set('email')} /></label>
          <label className="f span2"><span>Remarks</span><input value={f.remarks ?? ''} onChange={set('remarks')} /></label>
          <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto' }} checked={!!f.is_primary} onChange={set('is_primary')} />Main contact</label>
        </div>}
        <Owners customerId={customerId} />
        <div className="actions">
          {d?.can_edit && !f && <button className="btn" onClick={() => setF({})}>Add contact</button>}
          {f && <><button className="btn" onClick={() => setF(null)}>Cancel</button><button className="btn primary" onClick={() => save(f)}>Save contact</button></>}
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
