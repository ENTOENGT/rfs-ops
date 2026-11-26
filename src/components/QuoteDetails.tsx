'use client';
import { useState } from 'react';
import { api, fmtDateTime, fmtMoney } from './api';
import { routeLabel } from '@/lib/routingRules';
import { detailText } from '@/lib/jobfileRules';

const FIELDS: [string, string, string][] = [['pol', 'POL', 'text'], ['pod', 'POD', 'text'], ['line', 'Line / airline', 'text'], ['transit_days', 'Transit (days)', 'number'],
  ['free_days', 'Free days', 'number'], ['etd', 'ETD', 'date'], ['eta', 'ETA', 'date'], ['valid_until', 'Valid until', 'date']];

/**
 * 26 Nov: the shipment details the customer sees for each option (PDF, print, Excel, email). They come from the option's
 * vendor rate; anything typed here wins. Empty box = from the vendor rate (shown greyed). What is still missing is flagged.
 */
export function QuoteDetails({ d, onSaved }: { d: any; onSaved: (r: any) => void }) {
  const [f, setF] = useState<any>(null);
  const [err, setErr] = useState('');
  if (!d.details?.length && !d.scope_flags?.length) return null;
  const save = async () => {
    setErr('');
    try { onSaved(await api(`/api/quotations/${d.id}`, { method: 'PATCH', body: { details: f } })); setF(null); }
    catch (e: any) { setErr(e.message); }
  };
  const name = (o: any) => (o.option_no && d.details.length > 1 ? `Option ${o.option_no}` : 'Shipment');
  return (
    <div className="panel"><div style={{ display: 'flex', alignItems: 'center' }}><h2 style={{ margin: 0 }}>Shipment details for the customer</h2><span className="spacer" />
      {d.can.edit && !f && <button className="btn small" onClick={() => setF(JSON.parse(JSON.stringify(d.details_saved ?? {})))}>Change</button>}</div>
      {err && <div className="msg err small">{err}</div>}
      {d.scope_flags?.length > 0 && <div className="msg warn small" style={{ marginTop: 8 }}><b>Incoterm check:</b> {d.scope_flags.join(' ')}</div>}
      {d.details.map((o: any) => <div key={o.key} style={{ marginTop: 8 }}>
        <b className="small">{name(o)}</b>
        {!f ? <p className="small" style={{ margin: '2px 0' }}>{detailText(o) || '—'}</p>
          : <div className="grid g4" style={{ marginTop: 4 }}>{FIELDS.map(([k, label, type]) => <label key={k} className="f"><span>{label}</span>
            <input type={type} value={f[o.key]?.[k] ?? ''} placeholder={o[k] === null || o[k] === undefined ? '' : String(o[k])}
              onChange={(e) => setF({ ...f, [o.key]: { ...(f[o.key] ?? {}), [k]: e.target.value } })} /></label>)}</div>}
        {o.missing.length > 0 && <div className="small" style={{ color: '#B7791F' }}>Missing: {o.missing.join(', ')}</div>}
      </div>)}
      {f && <><p className="muted small">Empty box = taken from the vendor rate (shown in grey). ETA is worked out from ETD + transit when left empty.
        {d.status !== 'draft' && ' Saving puts the quotation back to draft for approval.'}</p>
        <div className="actions" style={{ justifyContent: 'flex-start' }}><button className="btn" onClick={() => setF(null)}>Cancel</button>
          <button className="btn primary" onClick={save}>Save details</button></div></>}
    </div>
  );
}

/** 26 Nov: what the customer answered with the buttons in the quotation email. Nothing is applied by itself — confirm or revise as usual. */
export function QuoteAnswers({ d, onSaved }: { d: any; onSaved: (r: any) => void }) {
  const [err, setErr] = useState('');
  if (!d.answers?.length) return null;
  const COLOR: Record<string, string> = { accepted: '#22543D', rejected: '#9B2C2C', negotiate: '#B7791F' };
  const NAME: Record<string, string> = { accepted: 'Accepted', rejected: 'Rejected', negotiate: 'Wants to negotiate' };
  const handled = async (id: string) => { setErr(''); try { onSaved(await api(`/api/quotations/${d.id}/answers`, { body: { answer_id: id } })); } catch (e: any) { setErr(e.message); } };
  return (
    <div className="panel" role="region" aria-label="Customer answers"><h2 style={{ marginTop: 0 }}>Customer answered from the email</h2>
      {err && <div className="msg err small">{err}</div>}
      {d.answers.map((a: any) => <div key={a.id} style={{ display: 'flex', gap: 10, alignItems: 'start', padding: '6px 0', borderTop: '1px solid var(--line, #e2e8f0)', opacity: a.handled_at ? 0.6 : 1 }}>
        <div style={{ flex: 1 }}>
          <b style={{ color: COLOR[a.answer] }}>{NAME[a.answer]}</b>{a.option_no && d.answers.length + (d.options?.length ?? 0) > 1 && <span> · {routeLabel(a)}</span>}
          {a.version_no !== d.version_no && <span className="muted small"> · version {a.version_no}</span>}
          {a.target_rate && <div className="small">Target rate: <b>{fmtMoney(a.target_rate, a.target_currency)}</b></div>}
          {a.reason && <div className="small">Reason: {a.reason}</div>}
          {a.comment && <div className="small">Comment: {a.comment}</div>}
          <div className="muted small">{fmtDateTime(a.answered_at)}{a.handled_at && ` · handled by ${a.handled_by_name ?? '—'}`}</div>
        </div>
        {!a.handled_at && <button className="btn small" onClick={() => handled(a.id)}>Handled</button>}
      </div>)}
      <p className="muted small" style={{ marginBottom: 0 }}>Nothing changes by itself: confirm the option with "Customer confirmed", or make a revision for a negotiation.</p>
    </div>
  );
}
