'use client';
import { useEffect, useState } from 'react';
import { api } from './api';

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
        <div className="actions">
          {d?.can_edit && !f && <button className="btn" onClick={() => setF({})}>Add contact</button>}
          {f && <><button className="btn" onClick={() => setF(null)}>Cancel</button><button className="btn primary" onClick={() => save(f)}>Save contact</button></>}
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
