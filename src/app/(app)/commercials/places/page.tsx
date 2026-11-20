'use client';
/** Migration 034 — Ports & regions: your regions (groups of countries, used by agent coverage) and your own ports / inland depots. */
import { useEffect, useState } from 'react';
import { api } from '@/components/api';
import { CountryPicker, loadCountries } from '@/components/PortPicker';

export default function Places() {
  const [d, setD] = useState<any>(null);
  const [f, setF] = useState<any>(null);
  const [port, setPort] = useState<any>(null);
  const [countries, setCountries] = useState<any[]>([]);
  const [note, setNote] = useState<{ t: 'ok' | 'err'; m: string } | null>(null);
  const load = () => api('/api/settings/regions').then(setD).catch((e) => setNote({ t: 'err', m: e.message }));
  useEffect(() => { load(); loadCountries().then(setCountries); }, []);
  const save = async () => {
    try { setD(await api('/api/settings/regions', { body: f })); setF(null); setNote({ t: 'ok', m: 'Region saved.' }); } catch (e: any) { setNote({ t: 'err', m: e.message }); }
  };
  const addPort = async () => {
    try { const r = await api('/api/ports', { body: port }); setPort(null); setNote({ t: 'ok', m: `Added ${r.name} (${r.code}). It now shows in every port box.` }); } catch (e: any) { setNote({ t: 'err', m: e.message }); }
  };
  const name = (c: string) => countries.find((x) => x.code === c)?.name ?? c;
  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <div className="page-head"><h1>Ports &amp; regions</h1></div>
      <p className="muted" style={{ marginTop: -6 }}>Every seaport and airport in the UN list (about 25,000) is already in the port boxes. Regions are your own
        groups of countries: give an agent a region under <b>Vendors → Coverage</b> and they are asked for every country in it.</p>
      {note && <div className={`msg ${note.t}`}>{note.m}</div>}
      <div className="panel">
        <div className="page-head" style={{ marginBottom: 6 }}><h2 style={{ margin: 0 }}>Regions</h2><span className="spacer" />
          {d?.can_manage && !f && <button className="btn" onClick={() => setF({ name: '', countries: [], is_active: true })}>Add region</button>}</div>
        {f && <div className="grid g2" style={{ marginBottom: 12 }}>
          <label className="f"><span>Name</span><input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. North Europe" /></label>
          <label className="f"><span>Add a country</span><CountryPicker value={null} placeholder="Choose a country to add"
            onChange={(c) => c && !f.countries.includes(c) && setF({ ...f, countries: [...f.countries, c] })} /></label>
          <div className="f span2"><span>Countries ({f.countries.length})</span><div className="chips">
            {f.countries.map((c: string) => <span key={c} className="chip">{name(c)} <button type="button" aria-label={`Remove ${name(c)}`} onClick={() => setF({ ...f, countries: f.countries.filter((x: string) => x !== c) })}>×</button></span>)}
            {f.countries.length === 0 && <span className="muted small">None yet.</span>}</div></div>
          <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto' }} checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> In use</label>
          <div className="actions span2" style={{ marginTop: 0 }}><button className="btn" onClick={() => setF(null)}>Cancel</button><button className="btn primary" onClick={save}>Save region</button></div>
        </div>}
        {!d ? <p className="muted">Loading…</p> : <div className="table-wrap"><table className="t">
          <thead><tr><th>Region</th><th>Countries</th>{d.can_manage && <th />}</tr></thead>
          <tbody>{d.rows.map((r: any) => <tr key={r.id} style={r.is_active ? undefined : { opacity: .55 }}>
            <td><b>{r.name}</b>{!r.is_active && <div className="muted small">Not in use</div>}</td>
            <td className="small">{r.country_list.map((c: any) => c.name).join(', ')}</td>
            {d.can_manage && <td style={{ textAlign: 'right' }}><button className="btn small" onClick={() => { setF({ id: r.id, name: r.name, countries: r.countries, is_active: r.is_active }); window.scrollTo(0, 0); }}>Edit</button></td>}
          </tr>)}</tbody></table></div>}
      </div>
      {d?.can_manage && <div className="panel">
        <div className="page-head" style={{ marginBottom: 6 }}><h2 style={{ margin: 0 }}>Your own ports</h2><span className="spacer" />
          {!port && <button className="btn" onClick={() => setPort({ kind: 'inland' })}>Add a port</button>}</div>
        <p className="muted small" style={{ marginTop: 0 }}>For an inland depot, ICD or a port missing from the UN list. Leave the code empty and one is made for you.</p>
        {port && <div className="grid g3">
          <label className="f"><span>Name</span><input autoFocus value={port.name ?? ''} onChange={(e) => setPort({ ...port, name: e.target.value })} /></label>
          <label className="f"><span>Country</span><CountryPicker value={port.country_code} onChange={(c) => setPort({ ...port, country_code: c })} /></label>
          <label className="f"><span>Kind</span><select value={port.kind} onChange={(e) => setPort({ ...port, kind: e.target.value })}>
            <option value="inland">Inland depot / ICD</option><option value="sea">Seaport</option><option value="air">Airport</option><option value="both">Seaport and airport</option></select></label>
          <label className="f"><span>Code (optional)</span><input value={port.code ?? ''} onChange={(e) => setPort({ ...port, code: e.target.value.toUpperCase() })} placeholder="e.g. AEX01" maxLength={5} /></label>
          <div className="actions span2" style={{ alignSelf: 'end', marginTop: 0 }}><button className="btn" onClick={() => setPort(null)}>Cancel</button><button className="btn primary" onClick={addPort}>Add port</button></div>
        </div>}
      </div>}
    </div>
  );
}
