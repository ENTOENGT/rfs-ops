'use client';
import { useEffect, useRef, useState } from 'react';
import { api, fmtDateTime } from './api';

const LABEL: Record<string, [string, string]> = { accepted: ['Accepted', 'rec-best'], changes: ['Wants changes', 'rec-ok'], declined: ['Declined', 'rec-no'], question: ['Question', 'rec-ok'] };

/**
 * 23 Nov (migration 041), on a sent quotation: the customer's emails since it went out, read by the AI by itself (once each).
 * Each reading waits for a person: the button uses the normal quotation step in their name. Nothing changes by itself.
 */
export function AiQuoteReply({ quotationId, onChanged }: { quotationId: string; onChanged: () => void }) {
  const [d, setD] = useState<any>(null);
  const [reading, setReading] = useState<any>(null);
  const [err, setErr] = useState('');
  const [pick, setPick] = useState<Record<string, any>>({});
  const [okMsg, setOkMsg] = useState('');   // every hook before the "return null" below (React error #310 otherwise)
  const tried = useRef<Set<string>>(new Set());
  const load = () => api(`/api/quotations/${quotationId}/ai-reply`).then(setD).catch(() => setD(null));
  useEffect(() => { load(); }, [quotationId]);
  const read = async (m: any) => {
    tried.current.add(m.id); setReading(m); setErr('');
    try { await api(`/api/quotations/${quotationId}/ai-reply`, { body: { email_id: m.id } }); } catch (e: any) { setErr(e.message); }
    setReading(null); load();
  };
  useEffect(() => { const m = d?.unread?.find((x: any) => !tried.current.has(x.id)); if (d?.configured && d.watching && m && !reading) read(m); }, [d, reading]);
  if (!d?.allowed || !d.watching && !(d.done ?? []).length || (!d.open?.length && !d.unread?.length && !reading && !err && !(d.done ?? []).length)) return null;
  // 26 Nov: the answer shows as handled at once; the saving runs behind it, and if it fails the box goes back as it was
  const act = async (s: any, b: any) => {
    setErr(''); const before = d;
    const opt = d.routes.find((r: any) => r.id === b.route_id);
    const said = b.action === 'accepted' ? `Customer accepted${opt ? ` Option ${opt.option_no}` : ''}` : b.action === 'declined' ? 'Customer declined' : b.action === 'changes' ? 'Customer asked for changes' : b.action === 'dismiss' ? 'Dismissed' : 'Saved';
    setD({ ...d, open: d.open.filter((x: any) => x.id !== s.id), done: [{ ...s, status: b.action === 'dismiss' ? 'dismissed' : 'applied', decided_by_name: 'you', saving: true }, ...(d.done ?? [])] });
    setOkMsg(`${said} — saving…`);
    try { setD(await api(`/api/ai/quote-replies/${s.id}`, { body: b })); setOkMsg(`${said} — saved.`); onChanged(); }
    catch (e: any) { setD(before); setOkMsg(''); setErr(`Not saved: ${e.message}`); }
  };
  const p = (s: any) => pick[s.id] ?? { action: s.answers.decision, reason: s.answers.reason ?? 'price', mark_lost: true,
    route_id: d.routes.find((r: any) => r.option_no === s.answers.chosen_option)?.id ?? '', note: '' };
  const setP = (s: any, v: any) => setPick({ ...pick, [s.id]: { ...p(s), ...v } });
  return (
    <div className="ai-box" role="region" aria-label="Customer's answer read by AI">
      <div className="ai-head"><span className="ai-tag">AI</span><b>Customer's answer</b><span className="muted small">— emails since the quotation was sent, read by AI. Check, then confirm.</span></div>
      {reading && <p className="small">Reading the email from {reading.from_name || reading.from_addr}…</p>}
      {err && <div className="msg err small">{err}</div>}
      {okMsg && <div className="msg ok small" role="status">{okMsg}</div>}
      {d.open.map((s: any) => { const v = p(s), a = s.answers; return <div key={s.id} className="ai-item">
        <p className="small" style={{ margin: '2px 0' }}><span className={`rec-tag ${LABEL[a.decision]?.[1]}`}>{LABEL[a.decision]?.[0]}</span>{' '}
          <b>{s.from_name || s.from_addr}</b> · {fmtDateTime(s.sent_at)} — {s.summary}</p>
        {a.quote && <span className="ai-quote">“{a.quote}”</span>}
        {a.changes?.length > 0 && <ul className="small" style={{ margin: '4px 0' }}>{a.changes.map((c: string, i: number) => <li key={i}>{c}</li>)}{a.target_price && <li>Target: {a.target_currency ?? ''} {a.target_price}</li>}</ul>}
        {a.question && <p className="small" style={{ margin: '4px 0' }}>Question: {a.question}</p>}
        <div className="grid g4" style={{ marginTop: 6 }}>
          <label className="f"><span>The customer…</span><select value={v.action} onChange={(e) => setP(s, { action: e.target.value })}>
            <option value="accepted">Accepted</option><option value="changes">Wants changes</option><option value="declined">Declined</option><option value="question">Asked a question</option></select></label>
          {v.action === 'accepted' && d.routes.length > 0 && <label className="f"><span>Option chosen</span><select value={v.route_id} onChange={(e) => setP(s, { route_id: e.target.value })}>
            <option value="">Choose…</option>{d.routes.map((r: any) => <option key={r.id} value={r.id}>Option {r.option_no}: {[r.pol, r.pod].filter(Boolean).join(' → ')}</option>)}</select></label>}
          {v.action === 'declined' && <><label className="f"><span>Why</span><select value={v.reason} onChange={(e) => setP(s, { reason: e.target.value })}>
            {d.reasons.map(([k, n]: [string, string]) => <option key={k} value={k}>{n}</option>)}</select></label>
            <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center', alignSelf: 'end', paddingBottom: 10 }}>
              <input type="checkbox" style={{ width: 'auto' }} checked={v.mark_lost} onChange={(e) => setP(s, { mark_lost: e.target.checked })} /> Mark the enquiry lost (reports)</label></>}
          {(v.action === 'changes' || v.action === 'question') && <label className="f" style={{ gridColumn: 'span 2' }}><span>Note (optional — the AI's reading is used when empty)</span>
            <input value={v.note} onChange={(e) => setP(s, { note: e.target.value })} /></label>}
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          <button className="btn small primary" onClick={() => act(s, { ...v, reason_text: undefined })}>
            {v.action === 'accepted' ? 'Confirm: customer accepted' : v.action === 'changes' ? 'Record: asked for changes' : v.action === 'declined' ? 'Confirm: not accepted' : 'Record the question'}</button>
          <button className="btn small" onClick={() => act(s, { action: 'dismiss' })}>Dismiss</button></div>
      </div>; })}
      {(d.done ?? []).length > 0 && <details className="small" style={{ marginTop: 6 }}><summary>{d.done.length} email{d.done.length === 1 ? '' : 's'} already handled</summary>
        {d.done.map((s: any) => <p key={s.id} style={{ margin: '4px 0 0 12px' }}>{s.from_name || s.from_addr} · {fmtDateTime(s.sent_at)} — {s.summary}
          <b>{s.status === 'applied' ? ' · confirmed' : s.status === 'dismissed' ? ' · dismissed' : ' · not about the quotation'}</b>{s.decided_by_name ? ` by ${s.decided_by_name}` : ''}</p>)}</details>}
      {!reading && d.unread.filter((m: any) => tried.current.has(m.id)).map((m: any) => <p key={m.id} className="small" style={{ margin: '4px 0' }}>
        Email from {m.from_name || m.from_addr} not read yet. <button className="linkish" onClick={() => read(m)}>Read with AI</button></p>)}
    </div>
  );
}
