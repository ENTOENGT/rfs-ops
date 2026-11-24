'use client';
import { useEffect, useRef, useState } from 'react';
import { api, fmtDate, fmtDateTime, fmtMoney } from './api';

/**
 * AI agent part B, under "Rates and quotation": an agent's / carrier's reply to a rate request is read by the AI by itself
 * (once) and the rate it found waits here. Check / correct it and press "Save rate" — nothing is saved on the request before.
 */
export function AiQuotes({ fileId, onSaved }: { fileId: string; onSaved: () => void }) {
  const [d, setD] = useState<any>(null);
  const [reading, setReading] = useState<any>(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [edit, setEdit] = useState<Record<string, any>>({});
  const [lines, setLines] = useState<Record<string, boolean>>({});
  // 24 Nov: the vendor gave several options — which one is saved on this request (main), which others go on the quotation too
  const [pick, setPick] = useState<Record<string, { main: number; extra: number[] }>>({});
  const tried = useRef<Set<string>>(new Set());
  const load = () => api(`/api/job-files/${fileId}/ai-quotes`).then(setD).catch(() => setD(null));
  useEffect(() => { load(); }, [fileId]);

  const read = async (m: any) => {
    tried.current.add(m.id); setReading(m); setErr('');
    try {
      const r = await api('/api/ai/quotes', { body: { email_id: m.id } });
      if (r.suggestion?.status === 'nothing') setOk(`${m.vendor_name}'s email "${String(m.subject ?? '').slice(0, 60)}" (${m.request_no}) has no rate in it.`);
    } catch (e: any) { setErr(e.message); }
    setReading(null); load();
  };
  // each vendor reply not read yet is read by itself, one after the other, once
  useEffect(() => {
    const m = d?.unread?.find((x: any) => !tried.current.has(x.id));
    if (d?.allowed && d.configured && m && !reading) read(m);
  }, [d, reading]);

  if (!d?.allowed || !d.configured || (!d.open.length && !d.no_rate.length && !reading && !err && !ok && !d.unread.length)) return null;
  const val = (s: any, k: string) => edit[s.id]?.[k] ?? s.rate?.[k] ?? '';
  const put = (s: any, k: string) => (e: any) => setEdit({ ...edit, [s.id]: { ...(edit[s.id] ?? {}), [k]: e.target.value } });
  const save = async (s: any) => {
    setErr(''); setOk('');
    const rate: any = {};
    for (const k of ['quoted_cost', 'currency', 'transit_days', 'free_days', 'etd', 'routing', 'carrier', 'rate_valid_until', 'vendor_reference', 'exclusions']) rate[k] = val(s, k) === '' ? null : val(s, k);
    const p = opts(s).length ? (pick[s.id] ?? { main: 0, extra: [] }) : null;
    try {
      const r = await api(`/api/ai/quotes/${s.id}`, { body: { action: 'apply', rate, use_charges: lines[s.id] ?? true, ...(p ? { main: p.main, extra: p.extra } : {}) } });
      setOk(`Rate saved on ${s.request_no} (${s.vendor_name}).${r.added?.length ? ` Also added as options for the quotation: ${r.added.join(', ')}.` : ''}`); load(); onSaved();
    } catch (e: any) { setErr(e.message); }
  };
  const dismiss = async (s: any) => { try { await api(`/api/ai/quotes/${s.id}`, { body: { action: 'dismiss' } }); load(); } catch (e: any) { setErr(e.message); } };
  const opts = (s: any): any[] => s.rate?.options ?? [];
  const mainOf = (s: any) => (opts(s).length ? opts(s)[(pick[s.id] ?? { main: 0 }).main] : s.rate);
  const choose = (s: any, i: number) => {
    const o = opts(s)[i], p = pick[s.id] ?? { main: 0, extra: [] };
    setPick({ ...pick, [s.id]: { main: i, extra: p.extra.filter((x) => x !== i) } });
    const e: any = {};
    for (const k of ['quoted_cost', 'currency', 'transit_days', 'free_days', 'etd', 'routing', 'carrier', 'rate_valid_until']) e[k] = o[k] ?? '';
    setEdit({ ...edit, [s.id]: { ...(edit[s.id] ?? {}), ...e } });
  };
  const toggle = (s: any, i: number, on: boolean) => { const p = pick[s.id] ?? { main: 0, extra: [] };
    setPick({ ...pick, [s.id]: { ...p, extra: on ? [...p.extra, i] : p.extra.filter((x) => x !== i) } }); };
  const field = (s: any, k: string, label: string, type = 'text', w = 1) => <label className="f" style={{ gridColumn: `span ${w}` }}><span>{label}</span>
    <input type={type} value={val(s, k) ?? ''} onChange={put(s, k)} /></label>;
  return (
    <div className="ai-box" role="region" aria-label="AI rates from vendors' emails">
      <div className="ai-head"><span className="ai-tag">AI</span><b>Rates from vendors' emails</b>
        <span className="muted small">— read by AI. Check them, then Save rate.</span></div>
      {reading && <p className="small" style={{ margin: '6px 0' }}>Reading {reading.vendor_name}'s reply ({reading.request_no})…</p>}
      {err && <div className="msg err small">{err}</div>}
      {ok && !d.open.some((s: any) => ok.includes(`(${s.request_no})`)) && <div className="msg ok small">{ok}</div>}
      {d.open.map((s: any) => {
        const m = mainOf(s), sameCur = (m?.charges ?? []).length > 0, p = pick[s.id] ?? { main: 0, extra: [] };
        return <div key={s.id} className="ai-item">
          <p className="small" style={{ margin: '4px 0 6px' }}><b>{s.vendor_name}</b> · {s.request_no} · {fmtDateTime(s.sent_at)}{s.summary && <> — {s.summary}</>}
            {s.request_status === 'quoted' && s.current_cost && <span className="muted"> (a rate is already in: {fmtMoney(s.current_cost, s.current_currency)} — saving makes this a new version)</span>}</p>
          {s.rate?.quote && <span className="ai-quote" style={{ marginBottom: 6 }}>“{s.rate.quote}”</span>}
          {opts(s).length > 0 && <div className="small" style={{ margin: '4px 0 8px' }}>
            <b>The vendor gave {opts(s).length} options.</b> Choose the one to save on {s.request_no}, and tick any others you also want to offer on the quotation (each becomes its own option, with its own total).
            <div className="table-wrap"><table className="t compact" style={{ marginTop: 4 }}>
              <thead><tr><th>Save on {s.request_no}</th><th>Also on the quotation</th><th>Option</th><th>Line / routing</th><th className="num">Transit</th><th className="num">Total</th></tr></thead>
              <tbody>{opts(s).map((o: any, i: number) => <tr key={i}>
                <td><input type="radio" style={{ width: 'auto' }} name={`main-${s.id}`} checked={p.main === i} onChange={() => choose(s, i)} aria-label={`Save ${o.label} on ${s.request_no}`} /></td>
                <td>{p.main === i ? <span className="muted">—</span> : <input type="checkbox" style={{ width: 'auto' }} checked={p.extra.includes(i)} onChange={(e) => toggle(s, i, e.target.checked)} aria-label={`Also offer ${o.label}`} />}</td>
                <td><b>{o.label}</b>{(o.pol || o.pod) && <div className="muted">{[o.pol, o.pod].filter(Boolean).join(' → ')}</div>}{o.note && <div style={{ color: '#B7791F' }}>{o.note}</div>}</td>
                <td>{[o.carrier, o.routing].filter(Boolean).join(' · ') || '—'}</td><td className="num">{o.transit_days ? `${o.transit_days} days` : '—'}</td>
                <td className="num">{fmtMoney(o.quoted_cost, o.currency)}</td></tr>)}</tbody></table></div>
            {p.extra.length > 0 && <p className="muted" style={{ margin: '4px 0 0' }}>The enquiry will then have route options: every new rate request asks which option it is for, and the customer chooses one option when confirming.</p>}
          </div>}
          <div className="grid g4">
            {field(s, 'quoted_cost', 'Rate (total) *', 'number')}
            <label className="f"><span>Currency *</span><select value={val(s, 'currency')} onChange={put(s, 'currency')}>
              {!['AED', 'USD', 'EUR', 'INR', 'CNY'].includes(val(s, 'currency')) && <option value={val(s, 'currency')}>{val(s, 'currency') || 'Choose'} (not used in RFS CRM)</option>}
              {['AED', 'USD', 'EUR', 'INR', 'CNY'].map((c) => <option key={c}>{c}</option>)}</select></label>
            {field(s, 'transit_days', 'Transit (days)', 'number')}
            {field(s, 'free_days', 'Free days', 'number')}
            {field(s, 'etd', 'ETD', 'date')}
            {field(s, 'rate_valid_until', 'Valid until', 'date')}
            {field(s, 'carrier', 'Line / airline')}
            {field(s, 'vendor_reference', 'Their reference')}
            {field(s, 'routing', 'Routing', 'text', 2)}
            {field(s, 'exclusions', 'Not included', 'text', 2)}
          </div>
          {(m?.charges_seen ?? []).length > 0 && <div className="small" style={{ marginTop: 6 }}>
            <table className="t compact"><thead><tr><th>Charge</th><th>Basis</th><th className="num">Qty</th><th className="num">Amount</th></tr></thead>
              <tbody>{m.charges_seen.map((l: any, i: number) => <tr key={i}><td>{l.description} <span className="muted">({l.section})</span></td><td>{l.basis ?? '—'}</td>
                <td className="num">{l.quantity}</td><td className="num">{l.currency} {Number(l.amount).toLocaleString()}</td></tr>)}</tbody></table>
            {sameCur ? <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center', marginTop: 4 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={lines[s.id] ?? true} onChange={(e) => setLines({ ...lines, [s.id]: e.target.checked })} />
              Save these charge lines too (only when the rate above is their total)</label>
              : <p className="muted small" style={{ margin: '4px 0' }}>The lines are in more than one currency: only the total is saved — add the lines on the request if needed.</p>}
          </div>}
          {s.unclear?.length > 0 && <p className="muted small" style={{ margin: '4px 0' }}>{s.unclear.map((u: any) => u.note).join(' · ')}</p>}
          <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
            <button className="btn small primary" onClick={() => save(s)}>{p.extra.length ? `Save rate + ${p.extra.length} option${p.extra.length === 1 ? '' : 's'}` : 'Save rate'}</button>
            <button className="btn small" onClick={() => dismiss(s)}>Dismiss</button></div>
        </div>;
      })}
      {d.no_rate.map((s: any) => <p key={s.id} className="small" style={{ margin: '6px 0' }}>
        <b>{s.vendor_name}</b> ({s.request_no}) replied {fmtDate(s.sent_at)} without a rate: <i>{s.unclear?.[0]?.note ?? s.summary}</i> — still waiting.
        {' '}<button className="linkish" onClick={() => dismiss(s)}>OK</button></p>)}
      {!reading && d.unread.filter((m: any) => tried.current.has(m.id)).map((m: any) => <p key={m.id} className="small" style={{ margin: '4px 0' }}>
        {m.vendor_name}'s reply ({m.request_no}) not read yet. <button className="linkish" onClick={() => read(m)}>Read with AI</button></p>)}
    </div>
  );
}
