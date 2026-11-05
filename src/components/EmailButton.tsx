'use client';
import { useState } from 'react';
import { api } from '@/components/api';

/**
 * "Email" button: the system writes the email, you check it, and your own email program (Outlook, Gmail…) opens with
 * it ready to send. Nothing is sent by the system; it only notes in the history that the email was prepared.
 */
export function EmailButton({ kind, id, label = 'Email', className = 'btn', update, onLogged }: {
  kind: 'vendor_request' | 'quotation' | 'job_file' | 'case'; id: string; label?: string; className?: string; update?: string; onLogged?: () => void;
}) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [extra, setExtra] = useState('');
  const [copied, setCopied] = useState(false);
  const load = async (u?: string) => {
    setErr(''); setCopied(false);
    try { const r = await api(`/api/email-draft?${new URLSearchParams({ kind, id, ...(u ?? update ? { update: (u ?? update)! } : {}) })}`); setD(r); }
    catch (e: any) { setErr(e.message); setD({ error: true }); }
  };
  const to = d?.recipients ? [...d.recipients.filter((r: any) => r.picked).map((r: any) => r.email),
    ...extra.split(/[,;\s]+/).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x))] : [];
  const mailto = d?.subject !== undefined
    ? `mailto:${to.map(encodeURIComponent).join(',')}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body.replace(/\r?\n/g, '\r\n'))}` : '';
  const log = () => api('/api/email-draft', { body: { kind, id, update: d.update, to, subject: d.subject } }).then(() => onLogged?.()).catch(() => {});
  const open = () => { window.location.href = mailto; log(); };
  const copy = async () => {
    try { await navigator.clipboard.writeText(`To: ${to.join(', ')}\nSubject: ${d.subject}\n\n${d.body}`); setCopied(true); log(); } catch { setErr('Copy did not work — select the text and copy it by hand.'); }
  };
  return <>
    <button className={className} type="button" onClick={() => load()}>✉ {label}</button>
    {d && <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setD(null)}><div className="modal wide" role="dialog" aria-label="Email">
      <h2>Email</h2>
      {err && <div className="msg err">{err}</div>}
      {!d.error && <>
        {d.note && <div className="msg warn small">{d.note}</div>}
        {d.options && <label className="f"><span>Which update?</span><select value={d.update} onChange={(e) => load(e.target.value)}>
          {d.options.map(([c, n]: [string, string]) => <option key={c} value={c}>{n}</option>)}</select></label>}
        <div className="f"><span>To</span>
          {d.recipients.length > 0 && <div className="checks">{d.recipients.map((r: any, i: number) => <label key={r.email} className="check">
            <input type="checkbox" checked={r.picked} onChange={() => setD({ ...d, recipients: d.recipients.map((x: any, j: number) => j === i ? { ...x, picked: !x.picked } : x) })} />
            {r.name} <span className="muted small">&lt;{r.email}&gt;{r.role ? ` · ${r.role}` : ''}</span></label>)}</div>}
          <input style={{ marginTop: 6 }} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Other email address(es), separated by commas" /></div>
        <label className="f"><span>Subject</span><input value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} /></label>
        <label className="f"><span>Message (you can change it here or in your email program)</span>
          <textarea rows={14} value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} style={{ fontFamily: 'inherit' }} /></label>
        {mailto.length > 1900 && <p className="muted small">This email is long. If your email program shows it cut short, use "Copy text" and paste it instead.</p>}
        {copied && <div className="msg ok small">Copied. Paste it into a new email.</div>}
      </>}
      <div className="actions"><button className="btn" onClick={() => setD(null)}>Close</button>
        {!d.error && <><button className="btn" onClick={copy}>Copy text</button>
          <button className="btn primary" disabled={to.length === 0} title={to.length ? '' : 'Choose or type at least one email address'} onClick={open}>Open in my email</button></>}</div>
    </div></div>}
  </>;
}
