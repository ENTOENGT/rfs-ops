'use client';
/**
 * 25 Nov (migration 044): the local charges rate cards — our cost for clearance, transport and handling at the Dubai end.
 * Kept by the admin, team leaders and anyone given "Manage local charges"; people who see cost can read them.
 * Every save keeps the old version (who, when). The quotation picks the card that fits by itself.
 */
import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '@/components/api';

const MODE_NAME: Record<string, string> = { sea_fcl: 'Sea FCL', sea_lcl: 'Sea LCL', air: 'Air', road: 'Road', courier: 'Courier' };
const blankLine = { description: '', service: 'clearance', unit: 'container', cost: '', cost_20: '', cost_40: '', min_amount: '', dg_extra: '', tag: 'always', sell_only: false, note: '' };
const blankCard = { name: '', mode: 'sea_fcl', direction: 'import', places: '', carriers: '', dg: 'no', currency: 'AED', notes: '', is_active: true, lines: [{ ...blankLine }] };

export default function LocalCharges() {
  const [d, setD] = useState<any>(null);
  const [f, setF] = useState<any>(null);
  const [hist, setHist] = useState<any[]>([]);
  const [msg, setMsg] = useState<{ t: 'ok' | 'err'; m: string } | null>(null);
  const load = () => api('/api/local-charges').then(setD).catch((e) => setMsg({ t: 'err', m: e.message }));
  useEffect(() => { load(); }, []);
  const open = async (id: string) => {
    try { const r = await api(`/api/local-charges/${id}`); setF({ ...r.card, lines: r.lines.map((l: any) => ({ ...l, ...Object.fromEntries(['cost', 'cost_20', 'cost_40', 'min_amount', 'dg_extra'].map((k) => [k, l[k] ?? ''])), note: l.note ?? '' })) }); setHist(r.history); window.scrollTo(0, 0); }
    catch (e: any) { setMsg({ t: 'err', m: e.message }); }
  };
  const save = async () => {
    try { await api(f.id ? `/api/local-charges/${f.id}` : '/api/local-charges', { method: f.id ? 'PUT' : 'POST', body: f }); setMsg({ t: 'ok', m: `${f.name} saved.` }); setF(null); load(); }
    catch (e: any) { setMsg({ t: 'err', m: e.message }); }
  };
  if (!d) return <div className="page">{msg ? <div className="msg err">{msg.m}</div> : <p className="muted">Loading…</p>}</div>;
  const ro = f?.id ? !d.can_edit : !d.can_add;   // migration 047: adding and changing are separate rights
  const L = (i: number, k: string, v: any) => setF({ ...f, lines: f.lines.map((l: any, j: number) => (j === i ? { ...l, [k]: v } : l)) });
  const move = (i: number, by: number) => { const ls = [...f.lines]; const [x] = ls.splice(i, 1); ls.splice(i + by, 0, x); setF({ ...f, lines: ls }); };
  return (
    <div className="page">
      <div className="page-head"><h1>Local charges</h1><span className="spacer" />{d.can_add && !f && <button className="btn primary" onClick={() => { setF({ ...blankCard, lines: [{ ...blankLine }] }); setHist([]); }}>Add card</button>}</div>
      <p className="muted" style={{ marginTop: 0 }}>Our cost for clearance, transport and handling. On a quotation, "Local charges" picks the card that fits the enquiry (mode, import / export, port or airport, airline, DG)
        and works out each charge from the containers (20 / 40 ft), BLs, documents and weight. {ro && 'You can read the cards; the admin and team leaders change them.'}</p>
      {msg && <div className={`msg ${msg.t}`}>{msg.m}</div>}

      {f && <div className="panel">
        <h2 style={{ marginTop: 0 }}>{f.id ? `${ro ? '' : 'Change '}"${f.name}"${f.version ? ` — version ${f.version}` : ''}` : 'New card'}</h2>
        <fieldset disabled={ro} style={{ border: 0, padding: 0, margin: 0 }}>
        <div className="grid g4">
          <label className="f span2"><span>Name <em>*</em></span><input value={f.name} placeholder="e.g. Sea import FCL – Jebel Ali clearance" onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="f"><span>Mode</span><select value={f.mode} onChange={(e) => setF({ ...f, mode: e.target.value })}>{d.modes.map((m: string) => <option key={m} value={m}>{MODE_NAME[m] ?? m}</option>)}</select></label>
          <label className="f"><span>Import / export</span><select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}><option value="import">Import</option><option value="export">Export</option></select></label>
          <label className="f span2"><span>Port / airport (words, comma between)</span><input value={f.places ?? ''} placeholder="e.g. Jebel Ali, AEJEA, JEA — empty = any" onChange={(e) => setF({ ...f, places: e.target.value })} /></label>
          <label className="f"><span>Line / airline (words)</span><input value={f.carriers ?? ''} placeholder="e.g. Emirates, EK — empty = any other" onChange={(e) => setF({ ...f, carriers: e.target.value })} /></label>
          <label className="f"><span>DG cargo</span><select value={f.dg} onChange={(e) => setF({ ...f, dg: e.target.value })}><option value="no">Non-DG only</option><option value="yes">DG only</option><option value="any">Both (DG extra per line)</option></select></label>
          <label className="f"><span>Currency</span><input value={f.currency} maxLength={3} onChange={(e) => setF({ ...f, currency: e.target.value.toUpperCase() })} /></label>
          <label className="f span2"><span>Notes (shown when used)</span><input value={f.notes ?? ''} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
          <label className="f" style={{ alignSelf: 'end' }}><span><input type="checkbox" style={{ width: 'auto' }} checked={f.is_active} onChange={(e) => setF({ ...f, is_active: e.target.checked })} /> In use</span></label>
        </div>
        <div className="table-wrap" style={{ marginTop: 10 }}><table className="t compact edit-grid" style={{ minWidth: 1220 }}>
          <thead><tr><th>Charge</th><th>Kind</th><th>Charged</th><th className="num">Amount</th><th className="num">20 ft</th><th className="num">40 ft</th><th className="num">Minimum</th><th className="num">DG extra</th><th>Tag</th><th style={{ textAlign: 'center' }}>Our charge</th><th>Note</th>{!ro && <th />}</tr></thead>
          <tbody>{f.lines.map((l: any, i: number) => <tr key={i}>
            <td style={{ minWidth: 200 }}><input value={l.description} onChange={(e) => L(i, 'description', e.target.value)} aria-label="Charge" title={l.description} /></td>
            <td style={{ minWidth: 135 }}><select aria-label="Kind" value={l.service} onChange={(e) => L(i, 'service', e.target.value)}>{d.services.map(([k, n]: string[]) => <option key={k} value={k}>{n}</option>)}</select></td>
            <td style={{ minWidth: 155 }}><select aria-label="Charged" value={l.unit} onChange={(e) => L(i, 'unit', e.target.value)}>{d.units.map(([k, n]: string[]) => <option key={k} value={k}>{n}</option>)}</select></td>
            {['cost', 'cost_20', 'cost_40', 'min_amount', 'dg_extra'].map((k) => <td key={k} className="num">
              <input style={{ width: 84, minWidth: 84, textAlign: 'right' }} inputMode="decimal" value={l[k] ?? ''} disabled={(k === 'cost_20' || k === 'cost_40') && l.unit !== 'container'}
                onChange={(e) => L(i, k, e.target.value)} aria-label={k} /></td>)}
            <td style={{ minWidth: 130 }}><select aria-label="Tag" value={l.tag} onChange={(e) => L(i, 'tag', e.target.value)}>{d.tags.map(([k, n]: string[]) => <option key={k} value={k}>{n}</option>)}</select></td>
            <td style={{ textAlign: 'center' }}><input type="checkbox" style={{ width: 'auto' }} checked={!!l.sell_only} onChange={(e) => L(i, 'sell_only', e.target.checked)} aria-label="Our selling charge" /></td>
            <td style={{ minWidth: 150 }}><input value={l.note ?? ''} onChange={(e) => L(i, 'note', e.target.value)} aria-label="Note" /></td>
            {!ro && <td style={{ whiteSpace: 'nowrap' }}><button type="button" className="btn small" disabled={!i} onClick={() => move(i, -1)} aria-label="Up">↑</button>
              <button type="button" className="btn small" disabled={i === f.lines.length - 1} onClick={() => move(i, 1)} aria-label="Down">↓</button>
              <button type="button" className="btn small" disabled={f.lines.length === 1} onClick={() => setF({ ...f, lines: f.lines.filter((_: any, j: number) => j !== i) })} aria-label="Remove">✕</button></td>}
          </tr>)}</tbody></table></div>
        </fieldset>
        <p className="muted small">Amount: per unit (for containers, when 20 ft and 40 ft cost the same). Per kg: the amount per kg and its minimum. % of invoice value: e.g. 5 for customs duty.
          "As per receipt": added with that note. "If applicable": shown to the customer, not in the total. "Our selling charge" (e.g. RFS handling): no cost; ticked on the quotation only when the customer pays it.</p>
        <div className="actions" style={{ justifyContent: 'flex-start' }}>
          {!ro && <button type="button" className="btn" onClick={() => setF({ ...f, lines: [...f.lines, { ...blankLine }] })}>+ Add charge</button>}
          <button className="btn" onClick={() => setF(null)}>{ro ? 'Close' : 'Cancel'}</button>
          {!ro && <button className="btn primary" disabled={!f.name.trim()} onClick={save}>Save card</button>}</div>
        {hist.length > 0 && <details className="small" style={{ marginTop: 8 }}><summary>Earlier versions ({hist.length})</summary>
          {hist.map((h) => <div key={h.version}>Version {h.version} · {h.user_name ?? '—'} · replaced {fmtDateTime(h.at)}</div>)}</details>}
      </div>}

      <div className="panel flush"><div className="table-wrap"><table className="t">
        <thead><tr><th>Card</th><th>Mode</th><th>Port / airport</th><th>Line / airline</th><th>DG</th><th className="num">Charges</th><th>Last changed</th><th /></tr></thead>
        <tbody>{d.cards.map((c: any) => <tr key={c.id} style={{ opacity: c.is_active ? 1 : 0.55 }}>
          <td style={{ minWidth: 170 }}><b>{c.name}</b>{!c.is_active && <span className="muted small"> · not in use</span>}</td>
          <td className="nowrap">{MODE_NAME[c.mode] ?? c.mode} {c.direction}</td><td className="small">{c.places || 'any'}</td><td className="small">{c.carriers || 'any other'}</td>
          <td className="nowrap">{c.dg === 'yes' ? 'DG' : c.dg === 'any' ? 'Both' : 'Non-DG'}</td><td className="num">{c.line_count}</td>
          <td className="small">v{c.version}{c.updated_by_name ? ` · ${c.updated_by_name}` : ''}<div className="muted">{fmtDateTime(c.updated_at)}</div></td>
          <td><button className="btn small" onClick={() => open(c.id)}>{d.can_edit ? 'Change' : 'View'}</button></td></tr>)}
          {!d.cards.length && <tr><td colSpan={8} className="muted">No cards yet.</td></tr>}</tbody></table></div></div>
    </div>
  );
}
