'use client';
import { useEffect, useState } from 'react';
import { api } from './api';

const MODES: [string, string][] = [['sea_fcl', 'Sea FCL'], ['sea_lcl', 'Sea LCL'], ['air', 'Air'], ['road', 'Road'], ['courier', 'Courier']];
const DIRS: [string, string][] = [['import', 'Import'], ['export', 'Export'], ['cross_trade', 'Cross trade']];
const names = (all: [string, string][], ks: string[]) => (ks.length ? ks.map((k) => all.find(([x]) => x === k)?.[1] ?? k).join(', ') : 'All');

/** Migration 038: a vendor's departments (Sea FCL team, Air import team…). A rate request goes to the team that fits. */
export default function VendorTeams({ vendorId, onClose }: { vendorId: string; onClose: () => void }) {
  const [d, setD] = useState<any>(null);
  const [f, setF] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api(`/api/vendors/${vendorId}/teams`).then(setD).catch((e) => setErr(e.message)); }, [vendorId]);
  const save = async (b: any) => {
    setErr('');
    try { setD(await api(`/api/vendors/${vendorId}/teams`, { body: b })); setF(null); } catch (e: any) { setErr(e.message); }
  };
  const tick = (k: 'modes' | 'directions', v: string) => setF({ ...f, [k]: (f[k] ?? []).includes(v) ? f[k].filter((x: string) => x !== v) : [...(f[k] ?? []), v] });
  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Vendor teams" style={{ width: 'min(880px, 96vw)', maxWidth: 'none' }}>
        <h2>{d?.vendor.name ?? '…'} — teams</h2>
        <p className="muted small" style={{ marginTop: -6 }}>When this vendor has a separate team for a service, the rate request goes to that team
          (e.g. the Sea FCL team for a sea FCL import). With no team for it, it goes to the vendor's own email{d?.vendor.email ? ` (${d.vendor.email})` : ''}.</p>
        {err && <div className="msg err">{err}</div>}
        {d && <div className="table-wrap"><table className="t">
          <thead><tr><th>Team</th><th>Modes</th><th>Direction</th><th>Email</th>{d.can_manage && <th />}</tr></thead>
          <tbody>{d.rows.map((r: any) => <tr key={r.id} className={r.is_active ? '' : 'muted'}>
            <td><b>{r.name}</b>{!r.is_active && ' (off)'}{r.contact_person && <div className="small">{r.contact_person}{r.phone ? ` · ${r.phone}` : ''}</div>}</td>
            <td className="small">{names(MODES, r.modes)}</td><td className="small">{names(DIRS, r.directions)}</td>
            <td className="small">{r.email}{r.cc_emails && <div className="muted">CC {r.cc_emails}</div>}</td>
            {d.can_manage && <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
              {r.is_active && <><button className="btn small" onClick={() => setF({ ...r })}>Edit</button>{' '}</>}
              <button className="btn small" onClick={() => save({ id: r.id, active: !r.is_active })}>{r.is_active ? 'Switch off' : 'Switch on'}</button></td>}
          </tr>)}
            {d.rows.length === 0 && <tr><td colSpan={5} className="muted">No teams — requests go to the vendor's own email.</td></tr>}</tbody></table></div>}
        {f && <div className="grid g2" style={{ marginTop: 12 }}>
          <label className="f"><span>Team name *</span><input value={f.name ?? ''} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Sea FCL team" /></label>
          <label className="f"><span>Contact person</span><input value={f.contact_person ?? ''} onChange={(e) => setF({ ...f, contact_person: e.target.value })} /></label>
          <label className="f"><span>Email *</span><input type="email" value={f.email ?? ''} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          <label className="f"><span>Phone</span><input value={f.phone ?? ''} onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
          <label className="f span2"><span>Also copy (CC) — other addresses, separated by commas</span><input value={f.cc_emails ?? ''} onChange={(e) => setF({ ...f, cc_emails: e.target.value })} /></label>
          <div className="f"><span>Modes <span className="muted small">— none ticked = all</span></span><div className="checks">
            {MODES.map(([k, n]) => <label key={k} className="check"><input type="checkbox" checked={(f.modes ?? []).includes(k)} onChange={() => tick('modes', k)} /> {n}</label>)}</div></div>
          <div className="f"><span>Direction <span className="muted small">— none ticked = all</span></span><div className="checks">
            {DIRS.map(([k, n]) => <label key={k} className="check"><input type="checkbox" checked={(f.directions ?? []).includes(k)} onChange={() => tick('directions', k)} /> {n}</label>)}</div></div>
          <label className="f span2"><span>Note</span><input value={f.note ?? ''} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        </div>}
        <div className="actions">
          {d?.can_manage && !f && <button className="btn" onClick={() => setF({ modes: [], directions: [] })}>Add team</button>}
          {f && <><button className="btn" onClick={() => setF(null)}>Cancel</button><button className="btn primary" onClick={() => save(f)}>Save</button></>}
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
