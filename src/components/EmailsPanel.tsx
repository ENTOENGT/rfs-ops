'use client';
import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '@/components/api';
import { uploadToShipment } from '@/components/CommercialPanels';
import { emailTemplateName } from '@/lib/templateRules';

/**
 * The shipment's Emails tab (Part G1): every email prepared with the Email button and every saved .msg / .eml file,
 * newest first, with sender, recipients, subject, date and attachments. The fixed subject is shown at the top to copy.
 */
export function EmailsPanel({ d, onSaved }: { d: any; onSaved?: () => void }) {
  const [e, setE] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok?: string; err?: string }>({});
  const [openId, setOpenId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const load = () => api(`/api/job-files/${d.id}/emails`).then(setE).catch((x) => setMsg({ err: x.message }));
  useEffect(() => { load(); }, [d.id]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!e) return null;
  const save = async (file: File) => {
    setBusy(true); setMsg({});
    try {
      const docId = await uploadToShipment(d.id, file, 'correspondence', 'Saved email');
      let r: any;
      try { r = await api(`/api/job-files/${d.id}/emails`, { body: { document_id: docId } }); }
      catch (x: any) {
        if (x.code !== 'EMAIL_OTHER_SHIPMENT' || !confirm(x.message)) throw x;
        r = await api(`/api/job-files/${d.id}/emails`, { body: { document_id: docId, force: true } });
      }
      setE(r); onSaved?.();
      setMsg({ ok: `Email saved${r.skipped > 0 ? `. ${r.skipped} attachment(s) were not kept (type not allowed or over 10 MB).` : '.'}` });
    } catch (x: any) { setMsg({ err: x.message }); }
    setBusy(false);
  };
  const pick = () => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = '.msg,.eml';
    i.onchange = () => { if (i.files?.[0]) save(i.files[0]); };
    i.click();
  };
  const openDoc = (docId: string) => window.open(`/api/jf-files/${docId}`, '_blank');
  const copy = async () => { try { await navigator.clipboard.writeText(e.thread_subject); setCopied(true); setTimeout(() => setCopied(false), 2000); } catch { /* select by hand */ } };
  return (
    <div className="panel"><h2>Emails</h2>
      <p className="small" style={{ marginTop: 0 }}>Email subject for this shipment: <b className="mono">{e.thread_subject}</b>{' '}
        <button className="linkish" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button></p>
      {msg.err && <div className="msg err small">{msg.err}</div>}{msg.ok && <div className="msg ok small">{msg.ok}</div>}
      {e.rows.length === 0 && <p className="muted small">No emails yet. Emails made with the Email button appear here, and you can add any email saved from Outlook.</p>}
      {e.rows.map((m: any) => <div key={m.id} className="email-row" style={{ borderTop: '1px solid var(--line-soft)', padding: '8px 0' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
          <span className={`badge ${m.direction === 'in' ? '' : 'outline'}`} style={m.direction === 'in' ? { background: '#2B6CB0' } : undefined}>
            {m.direction === 'in' ? 'Received' : m.status === 'prepared' ? 'Prepared' : 'Sent'}</span>
          <b style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{m.subject ?? '(no subject)'}</b>
          <span className="spacer" /><span className="muted small">{fmtDateTime(m.sent_at ?? m.created_at)}</span>
        </div>
        <div className="small muted">{m.direction === 'in' ? `From ${m.from_name ? `${m.from_name} <${m.from_addr}>` : m.from_addr ?? '—'}` : `By ${m.from_name ?? m.created_by_name}`}
          {m.to_addrs && ` · to ${m.to_addrs}`}{m.cc_addrs && ` · cc ${m.cc_addrs}`}
          {m.template_key && ` · ${emailTemplateName(m.template_key)}`}{m.request_no && ` · ${m.request_no}`}{m.quote_no && ` · ${m.quote_no}`}</div>
        <div className="small" style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 2 }}>
          {m.body_excerpt && <button className="linkish" onClick={() => setOpenId(openId === m.id ? null : m.id)}>{openId === m.id ? 'Hide text' : 'Show text'}</button>}
          {m.document_id && <button className="linkish" onClick={() => openDoc(m.document_id)}>Open email file</button>}
          {m.attachments.map((a: any) => <button key={a.id} className="linkish" onClick={() => openDoc(a.id)}>📎 {a.file_name}</button>)}
        </div>
        {openId === m.id && <pre className="small" style={{ whiteSpace: 'pre-wrap', background: 'var(--bg-soft, #F7F7F5)', padding: 8, borderRadius: 6, margin: '6px 0 0' }}>{m.body_excerpt}</pre>}
      </div>)}
      {d.can.edit && <div style={{ marginTop: 10 }}><button className="btn small" disabled={busy} onClick={pick}>{busy ? 'Reading the email…' : 'Add a saved email (.msg / .eml)'}</button>
        <span className="muted small" style={{ marginLeft: 8 }}>In Outlook: drag the email to your desktop, then choose it here.</span></div>}
    </div>
  );
}
