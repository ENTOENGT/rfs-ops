'use client';
import Link from 'next/link';
/** "My Outlook" (pilot users): connect or disconnect your own Outlook (step 1), check the inbox and file the emails no shipment matched (step 3). */
import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '@/components/api';

export default function MyOutlook() {
  const [s, setS] = useState<any>(null);
  const [note, setNote] = useState<{ t: 'ok' | 'err'; m: string } | null>(null);
  const load = () => api('/api/outlook').then(setS).catch((e) => setNote({ t: 'err', m: e.message }));
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('connected')) setNote({ t: 'ok', m: `Outlook connected: ${p.get('connected')}` });
    if (p.get('error')) setNote({ t: 'err', m: p.get('error')! });
    if (p.get('connected') || p.get('error')) window.history.replaceState(null, '', '/outlook');
    load();
  }, []);
  const off = async () => {
    if (!confirm('Disconnect your Outlook from RFS CRM? You can connect again at any time.')) return;
    try { await api('/api/outlook', { method: 'DELETE' }); setNote({ t: 'ok', m: 'Outlook disconnected.' }); load(); } catch (e: any) { setNote({ t: 'err', m: e.message }); }
  };
  return (
    <div className="page" style={{ maxWidth: 1180 }}>
      <div className="page-head"><h1>My Outlook</h1></div>
      {note && <div className={`msg ${note.t}`}>{note.m}</div>}
      {!s ? <p className="muted">Loading…</p> : <div className="panel">
        {!s.configured ? <p>The Outlook connection is not switched on yet. The Super Admin adds the Microsoft details in the hosting settings.</p>
          : !s.pilot ? <p>Outlook is open to the pilot users only for now. Ask the Super Admin if you should be one of them.</p>
          : s.connected ? <>
            <p style={{ marginTop: 0 }}><b>Connected:</b> {s.ms_email}{s.ms_name ? ` (${s.ms_name})` : ''}<br />
              <span className="muted small">Since {fmtDateTime(s.connected_at)}{s.last_sync_at ? ` · last checked ${fmtDateTime(s.last_sync_at)}` : ''}</span></p>
            {s.last_error && <div className="msg warn">{s.last_error}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              {s.last_error && <a className="btn primary" href="/api/outlook/connect">Connect again</a>}
              <button className="btn danger" onClick={off}>Disconnect</button></div>
          </> : <>
            <p style={{ marginTop: 0 }}>Connect your Outlook once. RFS CRM will then be able to send the emails you prepare from your own mailbox, and file the replies on the right shipment.</p>
            <ul className="muted small" style={{ lineHeight: 1.7 }}>
              <li>Only <b>your</b> mailbox, with your own Microsoft permissions — nobody else's.</li>
              <li>Nothing is sent without you pressing Send.</li>
              <li>You can disconnect here at any time; IT can also switch it off.</li>
            </ul>
            <a className="btn primary" href="/api/outlook/connect">Connect my Outlook</a>
          </>}
      </div>}
      {s?.connected && <Signature />}
      {s?.connected && !s.last_error && <Inbox />}
    </div>
  );
}

/** Step 3: check the inbox, and the emails from customers / agents that matched no shipment. */
function Inbox() {
  const [d, setD] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ t: 'ok' | 'err'; m: string } | null>(null);
  const [refs, setRefs] = useState<Record<string, string>>({});
  const [showAll, setShowAll] = useState(false);
  const load = (all = showAll) => api(`/api/outlook/inbox${all ? '?all=1' : ''}`).then(setD).catch((e) => setNote({ t: 'err', m: e.message }));
  const check = async (quiet = false) => {
    setBusy(true); if (!quiet) setNote(null);
    try {
      const r = await api('/api/outlook/sync', { body: {} });
      // migration 035: the AI looks at the emails that matched no shipment (new enquiry or not)
      let s: any = null;
      if (r.to_screen > 0) { setBusy(true); s = await api('/api/outlook/screen', { body: {} }).catch(() => null); }
      if (!quiet && r.busy) setNote({ t: 'ok', m: 'A check is already running. Wait a minute and press Check again.' });
      else if (!quiet) setNote({ t: 'ok', m: `Checked: ${r.filed} email(s) filed on shipments.${s?.new_enquiries ? ` The AI found ${s.new_enquiries} new enquiry email(s) — at the top below.` : ''}${r.more || s?.left ? ' More to read — press Check again.' : ''}` });
    } catch (e: any) { setNote({ t: 'err', m: e.message }); }
    setBusy(false); load();
  };
  // check on opening, then show what the every-minute check finds
  useEffect(() => { load(); check(true); const t = setInterval(() => load(), 60_000); return () => clearInterval(t); }, []);
  const act = async (id: string, b: any, ok: string) => {
    try { await api(`/api/outlook/inbox/${id}`, { body: b }); setNote({ t: 'ok', m: ok }); load(); } catch (e: any) { setNote({ t: 'err', m: e.message }); }
  };
  return (
    <div className="panel">
      <div className="page-head" style={{ marginBottom: 6 }}><h2 style={{ margin: 0 }}>Emails to file</h2><span className="spacer" />
        <button className="btn" disabled={busy} onClick={() => check()}>{busy ? 'Checking…' : 'Check inbox now'}</button></div>
      <p className="muted small" style={{ marginTop: 0 }}>RFS CRM reads your inbox (it never changes or deletes anything) and files each email on its shipment by the
        tag in the subject, like [ENQ-…] or the Job No., or by the same email conversation. Emails from your customers and agents that match
        no shipment wait here; the AI marks the ones that are <b>new enquiries</b> — also from new customers — and puts them at the top.
        Other emails are not saved. It also checks by itself every 2 minutes, even when RFS CRM is closed (every minute while it is open).</p>
      {note && <div className={`msg ${note.t}`}>{note.m}</div>}
      {d?.last_sync_at && <p className="muted small">Last checked {fmtDateTime(d.last_sync_at)}
        {d.other_hidden > 0 && <> · {d.other_hidden} other email(s) from customers hidden (the AI says they are not about a shipment) — <button className="linkish small" onClick={() => { setShowAll(true); load(true); }}>show them</button></>}
        {showAll && <> · <button className="linkish small" onClick={() => { setShowAll(false); load(false); }}>hide other emails</button></>}</p>}
      {!d ? <p className="muted">Loading…</p> : d.rows.length === 0 ? <div className="empty small">Nothing waiting. Every email from your customers and agents is on its shipment.</div>
        : <div className="table-wrap"><table className="t">
          <thead><tr><th>Received</th><th>From</th><th style={{ width: '45%' }}>Subject</th><th>File on shipment</th></tr></thead>
          <tbody>{d.rows.map((m: any) => <tr key={m.id} className={m.ai_kind === 'new_enquiry' ? 'row-new-enq' : undefined}>
            <td className="small" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(m.received_at)}</td>
            <td style={{ minWidth: 170 }}><b>{m.from_name || m.from_addr}</b><div className="muted small">{m.from_addr}</div>{m.known_as && <div className="small">{m.known_as}</div>}</td>
            <td>{m.ai_kind === 'new_enquiry' && <div style={{ marginBottom: 4 }}><span className="ai-tag">AI</span> <b className="small">New enquiry?</b>
                {m.ai_summary && <span className="small"> {m.ai_summary}</span>}</div>}
              {m.subject || <span className="muted">(no subject)</span>}{m.has_attachments && <span className="muted small"> · 📎</span>}
              {m.body_excerpt && <div className="muted small">{String(m.body_excerpt).slice(0, 200)}</div>}
              {m.web_link && <a className="small" href={m.web_link} target="_blank" rel="noopener">Open in Outlook</a>}</td>
            <td style={{ minWidth: 250 }}>
              {m.ai_kind === 'new_enquiry' && <Link className="btn small primary" style={{ marginBottom: 8, display: 'inline-block' }} href={`/job-files/new?from_email=${m.id}`}>Create enquiry</Link>}
              <div style={{ display: 'flex', gap: 6 }}>
              <input style={{ flex: 1, minWidth: 0 }} placeholder="ENQ / Job No. / Shipping Ref" value={refs[m.id] ?? ''} onChange={(e) => setRefs({ ...refs, [m.id]: e.target.value })}
                onKeyDown={(e) => e.key === 'Enter' && refs[m.id]?.trim() && act(m.id, { action: 'file', ref: refs[m.id] }, 'Filed on the shipment.')} />
              <button className={`btn small${m.ai_kind === 'new_enquiry' ? '' : ' primary'}`} disabled={!refs[m.id]?.trim()} onClick={() => act(m.id, { action: 'file', ref: refs[m.id] }, 'Filed on the shipment.')}>File</button></div>
              <button className="linkish small" style={{ marginTop: 6 }} onClick={() => act(m.id, { action: 'ignore' }, 'Hidden: not for a shipment.')}>Not for a shipment</button></td>
          </tr>)}</tbody></table></div>}
    </div>
  );
}

/** 26 Nov: my email signature (a JPG / PNG picture): added once under every email I send from RFS CRM. */
function Signature() {
  const [d, setD] = useState<any>(null);
  const [pending, setPending] = useState<{ url: string; width: number; height: number } | null>(null);
  const [note, setNote] = useState<{ t: 'ok' | 'err'; m: string } | null>(null);
  useEffect(() => { api('/api/outlook/signature').then(setD).catch(() => setD({ signature: null })); }, []);
  const pick = (f?: File) => {
    setNote(null);
    if (!f) return;
    if (!['image/png', 'image/jpeg'].includes(f.type)) return setNote({ t: 'err', m: 'Choose a JPG or PNG picture' });
    if (f.size > 400_000) return setNote({ t: 'err', m: 'The picture is too big — up to 400 KB' });
    const r = new FileReader();
    r.onload = () => { const img = new Image(); img.onload = () => setPending({ url: String(r.result), width: img.naturalWidth, height: img.naturalHeight }); img.src = String(r.result); };
    r.readAsDataURL(f);
  };
  const save = async (b: any, ok: string) => {
    try { setD(await api('/api/outlook/signature', { body: b })); setPending(null); setNote({ t: 'ok', m: ok }); } catch (e: any) { setNote({ t: 'err', m: e.message }); }
  };
  if (!d) return null;
  const show = pending ?? d.signature;
  return (
    <div className="panel">
      <h2 style={{ marginTop: 0 }}>My email signature</h2>
      <p className="muted small" style={{ marginTop: 0 }}>A picture of your company signature (JPG or PNG, up to 400 KB). It is added once under every email you send from RFS CRM — to customers and to vendors — at its own size (wider than 600 px is shown at 600 px).</p>
      {note && <div className={`msg ${note.t}`}>{note.m}</div>}
      {show ? <div style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 12, background: '#fff', display: 'inline-block', maxWidth: '100%' }}>
        <img src={show.url} alt="Signature preview" style={{ width: Math.min(show.width, 600), maxWidth: '100%', height: 'auto', display: 'block' }} />
        <div className="muted small" style={{ marginTop: 6 }}>{pending ? 'Preview — not saved yet' : 'Saved'} · {show.width} × {show.height} px</div></div>
        : <p className="muted">No signature yet.</p>}
      <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="btn"><input type="file" accept="image/png,image/jpeg" style={{ display: 'none' }} onChange={(e) => pick(e.target.files?.[0])} />{d.signature || pending ? 'Choose another picture' : 'Upload signature'}</label>
        {pending && <button className="btn primary" onClick={() => save({ data_url: pending.url, width: pending.width, height: pending.height }, 'Signature saved — it is added to your emails from now on.')}>Save signature</button>}
        {pending && <button className="btn" onClick={() => setPending(null)}>Cancel</button>}
        {d.signature && !pending && <button className="btn danger" onClick={() => { if (confirm('Remove your signature from your emails?')) save({ remove: true }, 'Signature removed.'); }}>Remove</button>}
      </div>
    </div>
  );
}
