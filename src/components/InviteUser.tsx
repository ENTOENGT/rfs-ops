'use client';
import { useEffect, useState } from 'react';
import { api } from './api';

/**
 * "Send invitation": a one-time link (48 hours) for the person to choose their own password.
 * Sent straight from your Outlook when it is connected; otherwise the email is shown, ready to open or copy.
 */
export default function InviteUser({ userId, name, onClose }: { userId: string; name: string; onClose: () => void }) {
  const [r, setR] = useState<any>(null);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  useEffect(() => { api(`/api/users/${userId}/invite`, { body: {} }).then(setR).catch((e) => setErr(e.message)); }, [userId]);
  const mailto = r && !r.sent ? `mailto:${encodeURIComponent(r.to)}?subject=${encodeURIComponent(r.subject)}&body=${encodeURIComponent(r.body.replace(/\r?\n/g, '\r\n'))}` : '';
  const copy = async () => {
    try { await navigator.clipboard.writeText(`To: ${r.to}\nSubject: ${r.subject}\n\n${r.body}`); setCopied(true); }
    catch { (document.getElementById('invite-text') as HTMLTextAreaElement | null)?.select(); }
  };
  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-label="Invitation">
        <h2>Invitation for {name}</h2>
        {!r && !err && <p className="muted">Making the link…</p>}
        {err && <div className="msg err">{err}</div>}
        {r?.sent && <div className="msg ok">Invitation emailed to <b>{r.to}</b> from your Outlook. The link works once, for {r.hours} hours.</div>}
        {r && !r.sent && <>
          <p className="small" style={{ marginTop: 0 }}>Your Outlook is not connected, so send this email yourself. The link works <b>once</b>, for <b>{r.hours} hours</b>. Any older link has stopped working.</p>
          <textarea id="invite-text" readOnly rows={12} value={`To: ${r.to}\nSubject: ${r.subject}\n\n${r.body}`} style={{ fontSize: 13 }} onFocus={(e) => e.currentTarget.select()} />
          {copied && <div className="msg ok small">Copied. Paste it into a new email.</div>}
        </>}
        <div className="actions">
          <button className="btn" onClick={onClose}>Close</button>
          {r && !r.sent && <><button className="btn" onClick={copy}>Copy text</button>
            <a className="btn primary" href={mailto}>Open in my email</a></>}
        </div>
        {r && <p className="muted small" style={{ marginBottom: 0 }}>Link expired, or they forgot their password? Press <b>Send invitation</b> again.</p>}
      </div>
    </div>
  );
}
