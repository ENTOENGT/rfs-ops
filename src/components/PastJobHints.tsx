'use client';
import { useEffect, useState } from 'react';
import { api } from './api';
import { EmailButton } from './EmailButton';

/**
 * Migration 038: for what is still missing, what this customer used on their past jobs — Accept, Edit or Ignore.
 * Never weight, size, pieces or dates. When the past jobs disagree, nothing is suggested: ask the customer.
 */
export function PastJobHints({ fileId, canEdit, onChanged }: { fileId: string; canEdit: boolean; onChanged: () => void }) {
  const [d, setD] = useState<any>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  useEffect(() => { api(`/api/job-files/${fileId}/history`).then(setD).catch(() => setD(null)); }, [fileId]);
  if (!d || (!d.hints.length && !d.unsure.length)) return null;
  const act = async (h: any, action: 'use' | 'ignore', value?: string) => {
    setErr('');
    try { setD(await api(`/api/job-files/${fileId}/history`, { body: { key: h.key, action, value } })); setEdit((x) => { const y = { ...x }; delete y[h.key]; return y; }); if (action === 'use') onChanged(); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="ai-box hist-box" role="region" aria-label="From past jobs">
      <div className="ai-head"><span className="ai-tag">AI</span><b>From this customer's past jobs</b>
        <span className="muted small">— suggestions, not confirmed. Weight, size, pieces and dates are never copied.</span></div>
      {err && <div className="msg err small">{err}</div>}
      {d.hints.map((h: any) => <div key={h.key} className="ai-item">
        <p className="small" style={{ margin: '2px 0' }}>We handled this before for this customer: <b>{h.label}</b> was{' '}
          {edit[h.key] === undefined ? <b>{h.value}</b> : <input value={edit[h.key]} onChange={(e) => setEdit({ ...edit, [h.key]: e.target.value })} style={{ maxWidth: 420 }} autoFocus />}
          <span className="muted"> — on {h.count} of the last {h.total} job{h.total === 1 ? '' : 's'} ({h.refs.map((r: any) => r.ref).join(', ')})</span></p>
        {canEdit && <div style={{ display: 'flex', gap: 6 }}>
          {edit[h.key] === undefined
            ? <><button className="btn small primary" onClick={() => act(h, 'use')}>Accept</button>
              <button className="btn small" onClick={() => setEdit({ ...edit, [h.key]: h.value })}>Edit</button>
              <button className="btn small" onClick={() => act(h, 'ignore')}>Ignore</button></>
            : <><button className="btn small primary" onClick={() => act(h, 'use', edit[h.key])}>Save</button>
              <button className="btn small" onClick={() => setEdit((x) => { const y = { ...x }; delete y[h.key]; return y; })}>Cancel</button></>}
        </div>}
      </div>)}
      {d.unsure.length > 0 && <p className="small" style={{ margin: '6px 0 0' }}>The past jobs don't agree on <b>{d.unsure.join(', ')}</b> — better to ask.{' '}
        {canEdit && <EmailButton kind="enquiry_missing" id={fileId} label="Ask the customer by email" className="btn small" onLogged={onChanged} />}</p>}
    </div>
  );
}
