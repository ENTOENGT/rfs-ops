'use client';
import { useState } from 'react';
import { api } from '@/components/api';

/**
 * "Email" button: the system writes the email and you check it. Then either
 *  - "Send from my Outlook" (Outlook pilot users who connected their mailbox): sent from your own mailbox, noted as sent; or
 *  - "Open in my email": your own email program opens with it ready to send; noted as prepared.
 */
export function EmailButton({ kind, id, label = 'Email', className = 'btn', update, onLogged }: {
  kind: 'vendor_request' | 'quotation' | 'job_file' | 'case' | 'enquiry_missing' | 'vendor_missing' | 'clarify_customer' | 'clarify_vendor'; id: string; label?: string; className?: string; update?: string; onLogged?: () => void;
}) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [extra, setExtra] = useState('');
  const [extraCc, setExtraCc] = useState('');
  const [copied, setCopied] = useState(false);
  const [outlook, setOutlook] = useState<any>(null);
  const [sending, setSending] = useState(false);
  const [sentTo, setSentTo] = useState<string[] | null>(null);
  const [attachPdf, setAttachPdf] = useState(true);              // 23 Nov: the quotation PDF goes with it
  const load = async (u?: string) => {
    setErr(''); setCopied(false); setSentTo(null);
    if (!outlook) api('/api/outlook').then(setOutlook).catch(() => setOutlook({}));
    try { const r = await api(`/api/email-draft?${new URLSearchParams({ kind, id, ...(u ?? update ? { update: (u ?? update)! } : {}) })}`); setD(r); }
    catch (e: any) { setErr(e.message); setD({ error: true }); }
  };
  const typed = (t: string) => t.split(/[,;\s]+/).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x));
  const to = d?.recipients ? [...d.recipients.filter((r: any) => r.picked && r.place !== 'cc').map((r: any) => r.email), ...typed(extra)] : [];
  const cc = d?.recipients ? [...d.recipients.filter((r: any) => r.picked && r.place === 'cc').map((r: any) => r.email), ...typed(extraCc)].filter((x) => !to.includes(x)) : [];
  const toggle = (email: string) => setD({ ...d, recipients: d.recipients.map((x: any) => x.email === email ? { ...x, picked: !x.picked } : x) });
  const removeP = async (email: string) => {
    if (!confirm(`Take ${email} off this shipment's emails? They will not be added again unless someone types them in.`)) return;
    try { await api(`/api/job-files/${d.file_id}/email-people`, { body: { email } }); setD({ ...d, recipients: d.recipients.filter((x: any) => x.email !== email) }); }
    catch (e: any) { setErr(e.message); }
  };
  const row = (r: any) => <label key={r.email} className="check" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
    <input type="checkbox" checked={r.picked} onChange={() => toggle(r.email)} />
    <span>{r.name !== r.email ? <>{r.name} </> : null}<span className="muted small">&lt;{r.email}&gt;{r.role ? ` · ${r.role}` : ''}</span></span>
    {r.removable && d.file_id && <button type="button" className="linkish small" title="Take off this shipment's emails" onClick={(e) => { e.preventDefault(); removeP(r.email); }}>×</button>}</label>;
  const mailto = d?.subject !== undefined
    ? `mailto:${to.map(encodeURIComponent).join(',')}?${cc.length ? `cc=${cc.map(encodeURIComponent).join(',')}&` : ''}subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body.replace(/\r?\n/g, '\r\n'))}` : '';
  const log = () => api('/api/email-draft', { body: { kind, id, update: d.update, to, cc, subject: d.subject, body: d.body } }).then(() => onLogged?.()).catch(() => {});
  const open = () => { window.location.href = mailto; log(); };
  const canSend = !!(outlook?.configured && outlook?.pilot && outlook?.connected);
  const send = async () => {
    setSending(true); setErr('');
    try { const r = await api('/api/email-send', { body: { kind, id, update: d.update, to, cc, subject: d.subject, body: d.body, attach_pdf: attachPdf } }); setSentTo(r.to); onLogged?.(); }
    catch (e: any) { setErr(e.message); }
    setSending(false);
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(`To: ${to.join(', ')}${cc.length ? `\nCC: ${cc.join(', ')}` : ''}\nSubject: ${d.subject}\n\n${d.body}`); setCopied(true); log(); } catch { setErr('Copy did not work — select the text and copy it by hand.'); }
  };
  return <>
    <button className={className} type="button" onClick={() => load()}>✉ {label}</button>
    {d && <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setD(null)}><div className="modal wide" role="dialog" aria-label="Email">
      <h2>Email</h2>
      {err && <div className="msg err">{err}</div>}
      {sentTo && <div className="msg ok">Sent from your Outlook ({outlook?.ms_email}) to {sentTo.join(', ')}{d.attach && attachPdf ? `, with ${d.attach.name}` : ''}. It is in your Sent Items too.</div>}
      {!d.error && !sentTo && <>
        {canSend && <p className="muted small" style={{ margin: '0 0 8px' }}>Sends from your Outlook: <b>{outlook.ms_email}</b></p>}
        {outlook?.pilot && outlook?.configured && !outlook?.connected && <div className="msg warn small">Connect your Outlook (menu → My Outlook) to send from here.</div>}
        {d.note && <div className="msg warn small">{d.note}</div>}
        {d.options && <label className="f"><span>Which email?</span><select value={d.update} onChange={(e) => load(e.target.value)}>
          {d.options.map(([c, n]: [string, string]) => <option key={c} value={c}>{n}</option>)}</select></label>}
        {d.template && <p className="muted small" style={{ margin: '0 0 8px' }}>Template: {d.template.name} ({d.template.source === 'saved' ? 'your company\'s template' : 'standard text'})</p>}
        {d.missing?.length > 0 && <div className="msg warn small">Not known yet — fill these in before sending: {d.missing.map((m: string) => `[${m}]`).join(', ')}</div>}
        <div className="f"><span>To</span>
          {d.recipients.some((r: any) => r.place !== 'cc') && <div className="checks">{d.recipients.filter((r: any) => r.place !== 'cc').map(row)}</div>}
          <input style={{ marginTop: 6 }} value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Other To address(es), separated by commas" /></div>
        <div className="f"><span>CC</span>
          {d.recipients.some((r: any) => r.place === 'cc') && <div className="checks">{d.recipients.filter((r: any) => r.place === 'cc').map(row)}</div>}
          <input style={{ marginTop: 6 }} value={extraCc} onChange={(e) => setExtraCc(e.target.value)} placeholder="Other CC address(es), separated by commas" />
          {d.file_id && <span className="muted small">Addresses you type here stay on this shipment's later emails. × takes someone off for good.</span>}</div>
        <label className="f"><span>Subject</span><input value={d.subject} onChange={(e) => setD({ ...d, subject: e.target.value })} /></label>
        <label className="f"><span>Message (you can change it here or in your email program)</span>
          <textarea rows={14} value={d.body} onChange={(e) => setD({ ...d, body: e.target.value })} style={{ fontFamily: 'inherit' }} /></label>
        {d.attach && <div className="attach-row">
          {canSend ? <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={attachPdf} onChange={(e) => setAttachPdf(e.target.checked)} />
            📎 Attach <b>{d.attach.name}</b> (made by RFS CRM){d.blocks && ' · the charges go as a table'}</label>
            : <span className="small">📎 For "Open in my email": <a href={`/api/quotations/${id}?format=pdf`}>download {d.attach.name}</a> and attach it.</span>}
          {canSend && <a className="small" href={`/api/quotations/${id}?format=pdf`} target="_blank" rel="noreferrer">See the PDF</a>}
        </div>}
        {mailto.length > 1900 && <p className="muted small">This email is long. If your email program shows it cut short, use "Copy text" and paste it instead.</p>}
        {copied && <div className="msg ok small">Copied. Paste it into a new email.</div>}
      </>}
      <div className="actions"><button className="btn" onClick={() => setD(null)}>Close</button>
        {!d.error && !sentTo && <><button className="btn" onClick={copy}>Copy text</button>
          <button className={canSend ? 'btn' : 'btn primary'} disabled={to.length === 0} title={to.length ? '' : 'Choose or type at least one email address'} onClick={open}>Open in my email</button>
          {canSend && <button className="btn primary" disabled={to.length === 0 || sending} title={to.length ? '' : 'Choose or type at least one email address'} onClick={send}>{sending ? 'Sending…' : 'Send from my Outlook'}</button>}</>}</div>
    </div></div>}
  </>;
}
