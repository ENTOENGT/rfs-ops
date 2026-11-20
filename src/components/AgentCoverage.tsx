'use client';
import { useEffect, useState } from 'react';
import { api } from './api';
import { CountryPicker, PortPicker } from './PortPicker';

const MODES: [string, string][] = [['sea_fcl', 'Sea FCL'], ['sea_lcl', 'Sea LCL'], ['air', 'Air'], ['road', 'Road'], ['courier', 'Courier']];
const SIDES: [string, string][] = [['both', 'Origin and destination'], ['origin', 'Origin only (pickup / loading there)'], ['destination', 'Destination only (delivery there)']];
const PRI: [number, string][] = [[1, 'Preferred'], [2, 'Normal'], [3, 'Backup']];

/** Where this agent works: ports, countries or regions — used to tick the right agents when asking for a rate. */
export default function AgentCoverage({ vendorId, onClose }: { vendorId: string; onClose: () => void }) {
  const [d, setD] = useState<any>(null);
  const [regions, setRegions] = useState<any[]>([]);
  const [f, setF] = useState<any>(null);
  const [err, setErr] = useState('');
  const load = () => api(`/api/vendors/${vendorId}/coverage`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); api('/api/settings/regions').then((r) => setRegions(r.rows.filter((x: any) => x.is_active))).catch(() => {}); }, [vendorId]);
  const save = async (b: any) => {
    setErr('');
    try { setD(await api(`/api/vendors/${vendorId}/coverage`, { body: b })); setF(null); } catch (e: any) { setErr(e.message); }
  };
  const where = (r: any) => r.scope === 'port' ? `${r.port_name} (${r.port_code}), ${r.port_country ?? ''}` : r.scope === 'country' ? `${r.country_name} — all ports` : `${r.region_name} (region)`;
  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Agent coverage" style={{ maxWidth: 820 }}>
        <h2>Where {d?.vendor.name ?? '…'} works</h2>
        <p className="muted small" style={{ marginTop: -6 }}>When someone asks for a rate, this agent is ticked for enquiries whose origin or destination is here.</p>
        {err && <div className="msg err">{err}</div>}
        {d && <div className="table-wrap"><table className="t">
          <thead><tr><th>Covers</th><th>Modes</th><th>Side</th><th>Priority</th>{d.can_manage && <th />}</tr></thead>
          <tbody>{d.rows.map((r: any) => <tr key={r.id}>
            <td><b>{where(r)}</b>{r.note && <div className="muted small">{r.note}</div>}</td>
            <td className="small">{r.modes.length ? r.modes.map((m: string) => MODES.find(([k]) => k === m)?.[1] ?? m).join(', ') : 'All'}</td>
            <td className="small">{SIDES.find(([k]) => k === r.side)?.[1].split(' (')[0]}</td>
            <td className="small">{PRI.find(([k]) => k === r.priority)?.[1]}</td>
            {d.can_manage && <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
              <button className="btn small" onClick={() => setF({ ...r })}>Edit</button>{' '}
              <button className="btn small danger" onClick={() => confirm('Remove this from the agent\'s coverage?') && save({ id: r.id, remove: true })}>Remove</button></td>}
          </tr>)}
            {d.rows.length === 0 && <tr><td colSpan={5} className="muted">Not set yet — add the ports, countries or regions this agent covers.</td></tr>}</tbody></table></div>}
        {f && <div className="grid g2" style={{ marginTop: 12 }}>
          <label className="f"><span>Covers</span><select value={f.scope ?? 'country'} onChange={(e) => setF({ ...f, scope: e.target.value })}>
            <option value="country">A whole country (all its ports)</option><option value="port">One port / airport</option><option value="region">A region (group of countries)</option></select></label>
          {(f.scope ?? 'country') === 'country' && <label className="f"><span>Country</span><CountryPicker value={f.country_code} onChange={(v) => setF({ ...f, country_code: v })} /></label>}
          {f.scope === 'port' && <label className="f"><span>Port / airport</span><PortPicker name={f.port_name} code={f.port_code}
            onChange={(v) => setF({ ...f, port_name: v.name, port_code: v.code })} /></label>}
          {f.scope === 'region' && <label className="f"><span>Region</span><select value={f.region_id ?? ''} onChange={(e) => setF({ ...f, region_id: e.target.value })}>
            <option value="">Choose</option>{regions.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></label>}
          <label className="f"><span>Side</span><select value={f.side ?? 'both'} onChange={(e) => setF({ ...f, side: e.target.value })}>
            {SIDES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
          <label className="f"><span>Priority</span><select value={f.priority ?? 2} onChange={(e) => setF({ ...f, priority: Number(e.target.value) })}>
            {PRI.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
          <div className="f span2"><span>Modes <span className="muted small">— none ticked = all modes</span></span><div className="checks">
            {MODES.map(([k, n]) => <label key={k} className="check"><input type="checkbox" checked={(f.modes ?? []).includes(k)}
              onChange={() => setF({ ...f, modes: (f.modes ?? []).includes(k) ? f.modes.filter((x: string) => x !== k) : [...(f.modes ?? []), k] })} /> {n}</label>)}</div></div>
          <label className="f span2"><span>Note</span><input value={f.note ?? ''} onChange={(e) => setF({ ...f, note: e.target.value })} placeholder="e.g. reefer only, good for Hamburg LCL" /></label>
        </div>}
        <div className="actions">
          {d?.can_manage && !f && <button className="btn" onClick={() => setF({ scope: 'country', side: 'both', priority: 2, modes: [] })}>Add coverage</button>}
          {f && <><button className="btn" onClick={() => setF(null)}>Cancel</button><button className="btn primary" onClick={() => save({ ...f, scope: f.scope ?? 'country' })}>Save</button></>}
          <button className="btn" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}
