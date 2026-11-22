'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';

/**
 * Migration 038, on the New enquiry form: once the customer, direction and mode are chosen, what this customer used on past
 * jobs for the details still empty — Accept fills the field, Edit lets you change it first, Ignore hides it. What was used is
 * logged on the enquiry when it is saved (f.history_used).
 */
export function FormHints({ f, setF }: { f: any; setF: (v: any) => void }) {
  const [d, setD] = useState<any>(null);
  const [hidden, setHidden] = useState<string[]>([]);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const t = useRef<any>(null);
  const key = [f.customer_id, f.direction, f.mode, f.incoterm, f.pol_code, f.pod_code, f.origin_country, f.destination_country, f.needs_transport].join('|');
  useEffect(() => {
    clearTimeout(t.current);
    if (!f.customer_id || !f.direction) { setD(null); return; }
    t.current = setTimeout(() => api('/api/history-preview', { body: { ...f, cargo_lines: [] } }).then(setD).catch(() => setD(null)), 500);
    return () => clearTimeout(t.current);
  }, [key]);
  const filled = (h: any) => (h.built_in ? String(f[h.key] ?? '').trim() : String(f.enquiry_details?.[h.key] ?? '').trim()) !== '';
  const hints = (d?.hints ?? []).filter((h: any) => !hidden.includes(h.key) && !filled(h));
  if (!hints.length) return null;
  const use = (h: any, value: string) => {
    const action = value === h.value ? 'accepted' : 'edited';
    const used = [...(f.history_used ?? []).filter((u: any) => u.key !== h.key), { key: h.key, label: h.label, value, action, from: h.refs.map((r: any) => r.ref).join(', ') }];
    setF(h.built_in ? { ...f, [h.key]: value, ...(action === 'accepted' ? h.extra : {}), history_used: used }
      : { ...f, enquiry_details: { ...(f.enquiry_details ?? {}), [h.key]: value }, history_used: used });
    setEdit((x) => { const y = { ...x }; delete y[h.key]; return y; });
  };
  return (
    <div className="ai-box hist-box" role="region" aria-label="From past jobs">
      <div className="ai-head"><span className="ai-tag">AI</span><b>From this customer's past jobs</b>
        <span className="muted small">— suggestions, not confirmed. Weight, size, pieces and dates are never copied.</span></div>
      {hints.map((h: any) => <div key={h.key} className="ai-item">
        <p className="small" style={{ margin: '2px 0' }}><b>{h.label}</b>:{' '}
          {edit[h.key] === undefined ? <b>{h.value}</b> : <input value={edit[h.key]} onChange={(e) => setEdit({ ...edit, [h.key]: e.target.value })} style={{ maxWidth: 420 }} autoFocus />}
          <span className="muted"> — on {h.count} of the last {h.total} job{h.total === 1 ? '' : 's'} ({h.refs.map((r: any) => r.ref).join(', ')})</span></p>
        <div style={{ display: 'flex', gap: 6 }}>
          {edit[h.key] === undefined
            ? <><button type="button" className="btn small primary" onClick={() => use(h, h.value)}>Accept</button>
              <button type="button" className="btn small" onClick={() => setEdit({ ...edit, [h.key]: h.value })}>Edit</button>
              <button type="button" className="btn small" onClick={() => setHidden([...hidden, h.key])}>Ignore</button></>
            : <><button type="button" className="btn small primary" onClick={() => edit[h.key].trim() && use(h, edit[h.key].trim())}>Use this</button>
              <button type="button" className="btn small" onClick={() => setEdit((x) => { const y = { ...x }; delete y[h.key]; return y; })}>Cancel</button></>}
        </div>
      </div>)}
    </div>
  );
}
