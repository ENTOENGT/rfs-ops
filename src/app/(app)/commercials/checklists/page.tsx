'use client';
/**
 * Release M (migration 028): the checklists the AI agent follows. Step 1 — the enquiry checklist: your own questions on top of
 * the built-in enquiry rules. Step 2 — the agent quote checklist. Kept by the Super Admin and Commercials Managers.
 */
import { useEffect, useState } from 'react';
import { api } from '@/components/api';

const TYPES: [string, string][] = [['text', 'Text'], ['yes_no', 'Yes / No'], ['date', 'Date'], ['number', 'Number']];
const BUILT_IN = ['Incoterm', 'The addresses and ports the Incoterm needs (pickup, handover place, loading / discharge port, delivery)',
  'Cargo value and currency for CIF / CIP', 'Cargo lines: packages, dimensions and weight (FCL: the total weight)', 'Commodity (description of the goods)'];
const blankItem = { label: '', ask_text: '', field_type: 'text', divisions: [] as string[], modes: [] as string[], sort: 100 };

function Picks({ all, value, onChange, none }: { all: [string, string][]; value: string[]; onChange: (v: string[]) => void; none: string }) {
  return <div className="chk-picks">{all.map(([k, l]) => (
    <label key={k} className="perm-chip"><input type="checkbox" checked={value.includes(k)} onChange={() => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k])} /><span>{l}</span></label>))}
    {!value.length && <span className="muted small">{none}</span>}</div>;
}

function EnquiryChecklist() {
  const [d, setD] = useState<any>(null);
  const [f, setF] = useState<any>(null);
  const [msg, setMsg] = useState<{ t: 'ok' | 'err'; m: string } | null>(null);
  useEffect(() => { api('/api/checklists/enquiry').then(setD).catch((e) => setMsg({ t: 'err', m: e.message })); }, []);
  const save = async (b: any, ok: string) => {
    try { setD(await api('/api/checklists/enquiry', { body: b })); setMsg({ t: 'ok', m: ok }); setF(null); } catch (e: any) { setMsg({ t: 'err', m: e.message }); }
  };
  const nm = (list: [string, string][], ks: string[]) => ks.length ? ks.map((k) => list.find(([x]) => x === k)?.[1] ?? k).join(', ') : 'All';
  if (!d) return <div>{msg ? <div className="msg err">{msg.m}</div> : <p className="muted">Loading…</p>}</div>;
  return (
    <div>
      <div className="role-head" style={{ marginBottom: 10 }}><p className="muted" style={{ margin: 0, flex: 1 }}>What an enquiry must say before it can be quoted. Missing items are shown on the enquiry with a ready email to ask the customer — and the AI assistant will follow the same list.</p>
        {d.can_manage && !f && <button className="btn primary" onClick={() => setF({ ...blankItem })}>Add item</button>}</div>
      {msg && <div className={`msg ${msg.t}`}>{msg.m}</div>}

      {f && <div className="panel">
        <h2 style={{ marginTop: 0 }}>{f.id ? `Change "${f.label}"` : 'New checklist item'}</h2>
        <div className="grid g2">
          <label className="f"><span>Item <em>*</em></span><input value={f.label} placeholder="e.g. HS code" onChange={(e) => setF({ ...f, label: e.target.value })} /></label>
          <label className="f"><span>Answer type</span><select value={f.field_type} onChange={(e) => setF({ ...f, field_type: e.target.value })}>{TYPES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          <label className="f span2"><span>How to ask the customer <em>*</em></span><input value={f.ask_text} placeholder="e.g. the HS code of the goods" onChange={(e) => setF({ ...f, ask_text: e.target.value })} />
            <small className="muted">It is put into the email as: "Could you please share: – {f.ask_text || '…'}"</small></label>
          <div className="f span2"><span>Divisions</span><Picks all={d.divisions} value={f.divisions} onChange={(v) => setF({ ...f, divisions: v })} none="None ticked = every division" /></div>
          <div className="f span2"><span>Modes</span><Picks all={d.modes} value={f.modes} onChange={(v) => setF({ ...f, modes: v })} none="None ticked = every mode" /></div>
          <label className="f"><span>Order</span><input type="number" min={1} max={999} value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} /></label>
        </div>
        <div className="actions" style={{ justifyContent: 'flex-start' }}><button className="btn" onClick={() => setF(null)}>Cancel</button>
          <button className="btn primary" disabled={!f.label.trim() || !f.ask_text.trim()} onClick={() => save(f, f.id ? 'Saved.' : `${f.label} added.`)}>Save</button></div>
      </div>}

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Always checked</h2>
        <p className="muted small" style={{ marginTop: 0 }}>Built into RFS CRM; they follow the Incoterm and the mode.</p>
        <ul className="chk-built">{BUILT_IN.map((x) => <li key={x}>{x}</li>)}</ul>
      </div>

      <div className="panel flush"><div className="table-wrap"><table className="t">
        <thead><tr><th>Your items</th><th>How it is asked</th><th>Answer</th><th>Divisions</th><th>Modes</th><th>Status</th>{d.can_manage && <th />}</tr></thead>
        <tbody>{d.rows.map((r: any) => (
          <tr key={r.id} style={{ opacity: r.is_active ? 1 : 0.55 }}>
            <td><b>{r.label}</b></td><td className="small">{r.ask_text}</td><td>{TYPES.find(([k]) => k === r.field_type)?.[1]}</td>
            <td className="small">{nm(d.divisions, r.divisions)}</td><td className="small">{nm(d.modes, r.modes)}</td>
            <td>{r.is_active ? 'On' : <span className="muted">Off</span>}</td>
            {d.can_manage && <td style={{ whiteSpace: 'nowrap' }}>
              <button className="btn small" onClick={() => { setF({ ...r }); window.scrollTo(0, 0); }}>Change</button>{' '}
              <button className="btn small" onClick={() => save({ ...r, is_active: !r.is_active }, `${r.label} switched ${r.is_active ? 'off' : 'on'}.`)}>{r.is_active ? 'Switch off' : 'Switch on'}</button></td>}
          </tr>))}
          {d.rows.length === 0 && <tr><td colSpan={7} className="muted" style={{ padding: 20, textAlign: 'center' }}>No items of your own yet.</td></tr>}
        </tbody></table></div></div>
    </div>
  );
}

/** Step 2: what an agent's rate must include. Items that read the rate request's own fields can be renamed, limited to some
 *  modes or switched off; new items are extra questions answered on the request. */
function QuoteChecklist() {
  const [d, setD] = useState<any>(null);
  const [f, setF] = useState<any>(null);
  const [msg, setMsg] = useState<{ t: 'ok' | 'err'; m: string } | null>(null);
  useEffect(() => { api('/api/checklists/quote').then(setD).catch((e) => setMsg({ t: 'err', m: e.message })); }, []);
  const save = async (b: any, ok: string) => {
    try { setD(await api('/api/checklists/quote', { body: b })); setMsg({ t: 'ok', m: ok }); setF(null); } catch (e: any) { setMsg({ t: 'err', m: e.message }); }
  };
  if (!d) return <div>{msg ? <div className="msg err">{msg.m}</div> : <p className="muted">Loading…</p>}</div>;
  const modesOf = (ks: string[]) => ks.length ? ks.map((k) => d.modes.find(([x]: any) => x === k)?.[1] ?? k).join(', ') : 'All';
  const readFrom = (k: string | null) => k ? d.fields.find(([x]: any) => x === k)?.[1] ?? k : 'Extra question — answered on the request';
  return (
    <div>
      <div className="role-head" style={{ marginBottom: 10 }}><p className="muted" style={{ margin: 0, flex: 1 }}>What an agent's rate must include. Once the agent replies, anything missing is shown on the rate request with a ready email to ask the agent — and the AI assistant will follow the same list.</p>
        {d.can_manage && !f && <button className="btn primary" onClick={() => setF({ label: '', ask_text: '', modes: [], sort: 200 })}>Add item</button>}</div>
      {msg && <div className={`msg ${msg.t}`}>{msg.m}</div>}
      {f && <div className="panel">
        <h2 style={{ marginTop: 0 }}>{f.id ? `Change "${f.label}"` : 'New item'}</h2>
        <div className="grid g2">
          <label className="f"><span>Item <em>*</em></span><input value={f.label} placeholder="e.g. Equipment availability" onChange={(e) => setF({ ...f, label: e.target.value })} /></label>
          <label className="f"><span>Order</span><input type="number" min={1} max={999} value={f.sort} onChange={(e) => setF({ ...f, sort: e.target.value })} /></label>
          <label className="f span2"><span>How to ask the agent <em>*</em></span><input value={f.ask_text} placeholder="e.g. whether equipment is available for the date" onChange={(e) => setF({ ...f, ask_text: e.target.value })} />
            <small className="muted">It is put into the email as: "Could you please also share: – {f.ask_text || '…'}"</small></label>
          <div className="f span2"><span>Modes</span><Picks all={d.modes} value={f.modes} onChange={(v) => setF({ ...f, modes: v })} none="None ticked = every mode" /></div>
          {f.id && <div className="f span2"><span>Read from</span><span className="muted">{readFrom(f.field_key)}</span></div>}
        </div>
        <div className="actions" style={{ justifyContent: 'flex-start' }}><button className="btn" onClick={() => setF(null)}>Cancel</button>
          <button className="btn primary" disabled={!f.label.trim() || !f.ask_text.trim()} onClick={() => save(f, f.id ? 'Saved.' : `${f.label} added.`)}>Save</button></div>
      </div>}
      <div className="panel flush"><div className="table-wrap"><table className="t">
        <thead><tr><th>Item</th><th>How it is asked</th><th>Checked from</th><th>Modes</th><th>Status</th>{d.can_manage && <th />}</tr></thead>
        <tbody>{d.rows.map((r: any) => (
          <tr key={r.id} style={{ opacity: r.is_active ? 1 : 0.55 }}>
            <td><b>{r.label}</b></td><td className="small">{r.ask_text}</td><td className="small">{readFrom(r.field_key)}</td><td className="small">{modesOf(r.modes)}</td>
            <td>{r.is_active ? 'On' : <span className="muted">Off</span>}</td>
            {d.can_manage && <td style={{ whiteSpace: 'nowrap' }}>
              <button className="btn small" onClick={() => { setF({ ...r }); window.scrollTo(0, 0); }}>Change</button>{' '}
              <button className="btn small" onClick={() => save({ ...r, is_active: !r.is_active }, `${r.label} switched ${r.is_active ? 'off' : 'on'}.`)}>{r.is_active ? 'Switch off' : 'Switch on'}</button></td>}
          </tr>))}</tbody></table></div></div>
    </div>
  );
}

export default function Checklists() {
  const [tab, setTab] = useState<'enquiry' | 'quote'>('enquiry');
  return (
    <div className="page">
      <div className="page-head"><h1>Checklists</h1></div>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'enquiry'} className={tab === 'enquiry' ? 'on' : ''} onClick={() => setTab('enquiry')}>Enquiry checklist</button>
        <button role="tab" aria-selected={tab === 'quote'} className={tab === 'quote' ? 'on' : ''} onClick={() => setTab('quote')}>Agent quote checklist</button>
      </div>
      {tab === 'enquiry' ? <EnquiryChecklist /> : <QuoteChecklist />}
    </div>
  );
}
