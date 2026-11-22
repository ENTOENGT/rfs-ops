'use client';
import { Fragment, useEffect, useRef, useState } from 'react';
import { api, fmtMoney } from './api';
import { EmailButton } from './EmailButton';

const VERDICT: Record<string, [string, string]> = { recommended: ['Recommended', 'rec-best'], suitable: ['Suitable', 'rec-ok'], not_suitable: ['Not suitable', 'rec-no'] };
const STATUS: Record<string, string> = { asked_customer: 'Asked the customer', asked_vendor: 'Asked the vendor', resolved: 'Solved internally' };

/**
 * Migration 039: under "Rates and quotation" — the AI compares the vendor rates against what the customer needs (compared
 * again by itself when the rates change) and lists the mismatches, each to ask the customer, ask the vendor or solve internally.
 */
export function AiRecommend({ fileId, onChanged }: { fileId: string; onChanged: () => void }) {
  const [d, setD] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const tried = useRef(false);
  const load = () => api(`/api/job-files/${fileId}/recommend`).then(setD).catch(() => setD(null));
  useEffect(() => { load(); }, [fileId]);
  const run = async () => {
    setBusy(true); setErr('');
    try { setD(await api(`/api/job-files/${fileId}/recommend`, { method: 'POST' })); onChanged(); } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  // the rates changed (or never compared): compare by itself, once per visit
  useEffect(() => { if (d?.allowed && d.configured && d.rates > 0 && !d.current && !tried.current) { tried.current = true; run(); } }, [d]);
  if (!d?.allowed || !d.rates) return null;
  const r = d.last?.result;
  const solve = async (i: any) => {
    const note = prompt('How was it solved? (kept in the history)');
    if (!note?.trim()) return;
    try { setD(await api(`/api/scope-issues/${i.id}`, { body: { action: 'resolved', note } })); onChanged(); } catch (e: any) { setErr(e.message); }
  };
  const reopen = async (i: any) => { try { setD(await api(`/api/scope-issues/${i.id}`, { body: { action: 'reopen' } })); } catch (e: any) { setErr(e.message); } };
  const open = d.issues.filter((i: any) => i.status === 'open'), done = d.issues.filter((i: any) => i.status !== 'open');
  return (
    <div className="ai-box rec-box" role="region" aria-label="AI vendor recommendation">
      <div className="ai-head"><span className="ai-tag">AI</span><b>Best vendor for this enquiry</b>
        <span className="muted small">— compares the full quotes with what the customer needs, not just the price.</span>
        <span className="spacer" />{d.configured && !busy && <button className="btn small" onClick={run}>{d.current ? 'Compare again' : 'Compare now'}</button>}</div>
      {busy && <p className="small">Comparing the vendor rates…</p>}
      {err && <div className="msg err small">{err}</div>}
      {r && !busy && <>
        {!d.current && <p className="muted small">The rates changed since this comparison.</p>}
        {r.recommended_request_id
          ? <div className="rec-pick"><b>Recommended: {r.recommended_vendor}</b> <span className="muted">({r.recommended_no})</span><p className="small" style={{ margin: '4px 0 0' }}>{r.reason}</p></div>
          : <div className="rec-pick rec-none"><b>No vendor meets the requirements</b><p className="small" style={{ margin: '4px 0 0' }}>{r.no_fit_reason || r.reason}</p></div>}
        <div className="table-wrap"><table className="t compact" style={{ marginTop: 8 }}>
          <thead><tr><th>Vendor</th><th className="num">Total</th><th className="num">≈ AED</th><th className="num">Transit</th><th className="num">Free days</th><th>Valid until</th><th>Verdict</th></tr></thead>
          <tbody>{r.vendors.map((v: any) => { const watch = [...v.missing_services.map((x: string) => `Missing: ${x}`), ...v.hidden_costs.map((x: string) => `Extra cost: ${x}`), ...v.risks];
            return <Fragment key={v.request_id}><tr>
            <td>{v.vendor_name}{v.team_name && <span className="muted"> · {v.team_name}</span>}<div className="muted small">{v.request_no}</div></td>
            <td className="num">{fmtMoney(v.total, v.currency)}</td><td className="num">{v.total_aed !== null ? fmtMoney(v.total_aed, 'AED') : '—'}</td>
            <td className="num">{v.transit_days ?? '—'}</td><td className="num">{v.free_days ?? '—'}</td>
            <td className={v.expired ? 'flag' : ''}>{v.rate_valid_until ? String(v.rate_valid_until).slice(0, 10) : '—'}{v.expired && ' (expired)'}</td>
            <td><span className={`rec-tag ${VERDICT[v.verdict]?.[1]}`}>{VERDICT[v.verdict]?.[0]}</span></td></tr>
            {watch.length > 0 && <tr className="rec-watch"><td colSpan={7} className="small">{watch.map((x: string, i: number) => <span key={i}>• {x} </span>)}</td></tr>}</Fragment>; })}</tbody></table></div>
      </>}
      {open.length > 0 && <div className="ai-flags" style={{ marginTop: 8 }}><b className="small">Mismatches to clear before quoting</b>
        {open.map((i: any) => <div key={i.id} className="rec-issue">
          <p className="small" style={{ margin: '4px 0 2px' }}>⚠ {i.issue}{i.vendor_name && <span className="muted"> ({i.vendor_name}, {i.request_no})</span>}</p>
          {i.question && <p className="muted small" style={{ margin: '0 0 4px 14px' }}>Suggested question: {i.question}</p>}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginLeft: 14 }}>
            <EmailButton kind="clarify_customer" id={i.id} label={`Email customer${i.target === 'customer' ? ' (suggested)' : ''}`} className="btn small" onLogged={() => { load(); onChanged(); }} />
            {i.vendor_request_id && <EmailButton kind="clarify_vendor" id={i.id} label={`Email vendor${i.target === 'vendor' ? ' (suggested)' : ''}`} className="btn small" onLogged={() => { load(); onChanged(); }} />}
            <button className="btn small" onClick={() => solve(i)}>{`Solved internally${i.target === 'internal' ? ' (suggested)' : ''}`}</button>
          </div></div>)}</div>}
      {done.length > 0 && <details className="small" style={{ marginTop: 6 }}><summary>{done.length} mismatch{done.length === 1 ? '' : 'es'} already handled</summary>
        {done.map((i: any) => <p key={i.id} style={{ margin: '4px 0 0 12px' }}>{i.issue} — <b>{STATUS[i.status]}</b>{i.decided_by_name ? ` by ${i.decided_by_name}` : ''}{i.note ? `: ${i.note}` : ''}
          {' '}<button className="linkish" onClick={() => reopen(i)}>Open again</button></p>)}</details>}
    </div>
  );
}
