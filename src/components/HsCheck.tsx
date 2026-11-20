'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';

/**
 * Migration 036: checks the HS codes typed (or read by the AI) against our HS code list — duty %, Active / In Active,
 * prohibited / restricted with the authority — or "Not in our record".
 */
export function HsCheck({ codes, compact }: { codes: string | null | undefined; compact?: boolean }) {
  const [r, setR] = useState<any>(null);
  const t = useRef<any>(null);
  useEffect(() => {
    clearTimeout(t.current);
    const v = String(codes ?? '').trim();
    if (!v) { setR(null); return; }
    t.current = setTimeout(() => api(`/api/hs-codes?codes=${encodeURIComponent(v)}`).then(setR).catch(() => setR(null)), 400);
    return () => clearTimeout(t.current);
  }, [codes]);
  if (!r?.results?.length) return null;
  if (!r.loaded) return <div className="muted small" style={{ marginTop: 4 }}>The HS code list is not loaded yet (Commercials → HS codes).</div>;
  return <div className="hs-check">{r.results.map((x: any) => {
    const bad = !x.found || x.level === 'invalid' || x.controls.some((c: any) => c.action_type === 'P');
    const warn = x.controls.length > 0 || !x.codes.some((c: any) => c.status === 'Active');   // restricted, or not an active code
    return <div key={x.code || x.input} className={`hs-line ${bad ? 'hs-bad' : warn ? 'hs-warn' : 'hs-ok'}`}>
      <b>{x.input}</b> — {x.message}
      {!compact && x.level === 'code' && x.codes[0]?.description && <div className="muted">{x.codes[0].description}</div>}
      {!compact && x.level === 'heading' && x.codes.length > 0 && <div className="muted">{x.codes.slice(0, 4).map((c: any) => `${c.code} ${c.description ?? ''}${c.status !== 'Active' ? ' (in active)' : ` · ${c.duty_pct}%`}`).join(' · ')}{x.more > 0 ? ` · +${x.more} more` : ''}</div>}
      {x.controls.slice(0, compact ? 1 : 3).map((c: any, i: number) => <div key={i}>{c.action_type === 'P' ? (c.fully_prohibited ? '⛔ Prohibited' : '⛔ Prohibited (conditions)') : '⚠ Restricted'}
        {c.authority ? ` — ${c.authority}` : ''}{c.remarks ? ` · ${c.remarks}` : ''}{x.level === 'heading' ? ` (${c.code})` : ''}</div>)}
    </div>;
  })}</div>;
}
