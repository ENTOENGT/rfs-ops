'use client';
import { useEffect, useRef, useState } from 'react';
import { api, fmtDate, fmtDateTime } from './api';

/**
 * AI agent part A, on an enquiry: the newest received email is read by the AI by itself (once); what it found waits here.
 * Nothing changes on the enquiry until you tick the answers and press "Fill in".
 */
export function AiSuggestions({ fileId, canEdit, hasGaps, onApplied }: { fileId: string; canEdit: boolean; hasGaps: boolean; onApplied: () => void }) {
  const [d, setD] = useState<any>(null);
  const [reading, setReading] = useState<any>(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [ticks, setTicks] = useState<Record<string, Record<string, boolean>>>({});
  const tried = useRef<Set<string>>(new Set());
  const load = () => api(`/api/job-files/${fileId}/ai`).then(setD).catch(() => setD(null));
  useEffect(() => { load(); }, [fileId]);

  const read = async (m: any) => {
    tried.current.add(m.id); setReading(m); setErr('');
    try {
      const r = await api(`/api/ai/emails/${m.id}`, { body: {} });
      if (r.suggestion?.status === 'nothing') setOk(`The AI read the email from ${m.from_name || m.from_addr}: it does not answer the missing details.`);
    } catch (e: any) { setErr(e.message); }
    setReading(null); load();
  };
  // the newest unread email is read by itself, once, when the enquiry still has missing details
  useEffect(() => {
    const m = d?.unread?.[0];
    if (d?.configured && canEdit && hasGaps && m && !reading && !tried.current.has(m.id)) read(m);
  }, [d, canEdit, hasGaps]);

  if (!d?.configured || (!d.open.length && !reading && !err && !ok && !(canEdit && hasGaps && d.unread.length))) return null;
  const tick = (sid: string, key: string, def: boolean) => ticks[sid]?.[key] ?? def;
  const apply = async (s: any) => {
    const keys = s.answers.filter((a: any) => !a.by_hand && tick(s.id, a.key, true)).map((a: any) => a.key);
    setErr(''); setOk('');
    try { const r = await api(`/api/ai/suggestions/${s.id}`, { body: { action: 'apply', keys } }); setOk(`Filled in ${r.applied} detail(s). Check what is still missing above.`); load(); onApplied(); }
    catch (e: any) { setErr(e.message); }
  };
  const dismiss = async (s: any) => {
    try { await api(`/api/ai/suggestions/${s.id}`, { body: { action: 'dismiss' } }); load(); } catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="ai-box" role="region" aria-label="AI suggestions">
      <div className="ai-head"><span className="ai-tag">AI</span><b>Suggestions from emails</b>
        <span className="muted small">— read by AI. Check them before filling in.</span></div>
      {reading && <p className="small" style={{ margin: '6px 0' }}>Reading the email from {reading.from_name || reading.from_addr}…</p>}
      {err && <div className="msg err small">{err}</div>}
      {ok && <div className="msg ok small">{ok}</div>}
      {d.open.map((s: any) => {
        const can = s.answers.filter((a: any) => !a.by_hand && tick(s.id, a.key, true)).length;
        return <div key={s.id} className="ai-item">
          <p className="small" style={{ margin: '4px 0 6px' }}>From <b>{s.from_name || s.from_addr}</b> · {fmtDateTime(s.sent_at)}{s.summary && <> — {s.summary}</>}</p>
          <ul className="ai-answers">{s.answers.map((a: any) => <li key={a.key}>
            {a.by_hand ? <span className="ai-hand">✎</span>
              : <input type="checkbox" aria-label={a.label} disabled={!canEdit} checked={tick(s.id, a.key, true)}
                onChange={(e) => setTicks({ ...ticks, [s.id]: { ...(ticks[s.id] ?? {}), [a.key]: e.target.checked } })} />}
            <span><b>{a.label}:</b> {a.value === 'yes' ? 'Yes' : a.value === 'no' ? 'No' : /^\d{4}-\d{2}-\d{2}$/.test(a.value) ? fmtDate(a.value) : a.value}
              {a.by_hand && <span className="muted small"> (fill in by hand — needs sizes per package)</span>}
              {a.quote && <span className="ai-quote">“{a.quote}”</span>}</span></li>)}</ul>
          {s.unclear.some((u: any) => u.key !== 'flag') && <p className="muted small" style={{ margin: '4px 0' }}>Not answered clearly: {s.unclear.filter((u: any) => u.key !== 'flag').map((u: any) => `${u.label}${u.note ? ` (${u.note})` : ''}`).join(', ')}</p>}
          {/* batch 1: contradictions and remarks that change price / services — to check, not to fill */}
          {s.unclear.some((u: any) => u.key === 'flag') && <div className="ai-flags">{s.unclear.filter((u: any) => u.key === 'flag').map((u: any, i: number) => <p key={i} className="small">⚠ {u.note}</p>)}</div>}
          {canEdit && <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
            <button className="btn small primary" disabled={!can} onClick={() => apply(s)}>Fill in ticked ({can})</button>
            <button className="btn small" onClick={() => dismiss(s)}>Dismiss</button></div>}
        </div>;
      })}
      {!reading && canEdit && hasGaps && d.unread.filter((m: any) => tried.current.has(m.id)).map((m: any) => <p key={m.id} className="small" style={{ margin: '4px 0' }}>
        Email from {m.from_name || m.from_addr} not read yet. <button className="linkish" onClick={() => read(m)}>Read with AI</button></p>)}
    </div>
  );
}
