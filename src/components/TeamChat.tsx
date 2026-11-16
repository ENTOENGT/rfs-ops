'use client';
/**
 * Release L step 11 (migration 027): the team chat of one shipment. New messages appear within about 8 seconds (the page asks
 * the server while it is open). @ to mention someone who can open the job; attach a file (saved with the job's documents);
 * correct your own message for 5 minutes. Internal only — never shown to customers or agents.
 */
import { useEffect, useRef, useState } from 'react';
import { api, fmtDateTime } from './api';
import { StatusDot } from './Presence';

const MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', pdf: 'application/pdf' };

export function TeamChat({ d }: { d: any }) {
  const [msgs, setMsgs] = useState<any[]>([]);
  const [people, setPeople] = useState<any[]>([]);
  const [reads, setReads] = useState<{ name: string; read_at: string }[]>([]);
  const [text, setText] = useState('');
  const [mentions, setMentions] = useState<{ id: string; full_name: string }[]>([]);
  const [pick, setPick] = useState<{ q: string; list: any[] } | null>(null);
  const [editing, setEditing] = useState<{ id: string; body: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const since = useRef<string | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const file = useRef<HTMLInputElement>(null);

  const merge = (rows: any[]) => setMsgs((old) => { const m = new Map(old.map((x) => [x.id, x])); rows.forEach((r) => m.set(r.id, { ...m.get(r.id), ...r })); return [...m.values()].sort((a, b) => a.created_at.localeCompare(b.created_at)); });
  const load = async (all = false) => {
    try {
      const r = await api(`/api/job-files/${d.id}/chat${!all && since.current ? `?after=${encodeURIComponent(since.current)}` : ''}`);
      if (all) setMsgs(r.messages); else if (r.messages.length) merge(r.messages);
      setPeople(r.people); setReads(r.reads ?? []); since.current = r.now;
    } catch (e: any) { setErr(e.message); }
  };
  useEffect(() => {
    load(true);
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 8000);
    return () => clearInterval(t);
  }, [d.id]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { end.current?.scrollIntoView({ block: 'nearest' }); }, [msgs.length]);

  // @ picker: typing "@ra" offers people who can open this job
  const onType = async (v: string) => {
    setText(v);
    const m = v.match(/@([\w .'-]{0,30})$/);
    if (!m) { setPick(null); return; }
    try { setPick({ q: m[1], list: await api(`/api/job-files/${d.id}/chat?mention=${encodeURIComponent(m[1].trim())}`) }); } catch { setPick(null); }
  };
  const choose = (u: any) => {
    setText(text.replace(/@([\w .'-]{0,30})$/, `@${u.full_name} `));
    if (!mentions.some((x) => x.id === u.id)) setMentions([...mentions, u]);
    setPick(null);
  };
  const send = async (documentId?: string) => {
    const body = text.trim();
    if (!body && !documentId) return;
    setBusy(true); setErr('');
    try {
      const m = await api(`/api/job-files/${d.id}/chat`, { body: { body, document_id: documentId, mentions: mentions.filter((x) => body.includes(`@${x.full_name}`)).map((x) => x.id) } });
      merge([m]); setText(''); setMentions([]);
    } catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const attach = async (f: File) => {
    setBusy(true); setErr('');
    try {
      const mime = f.type || MIME[f.name.split('.').pop()!.toLowerCase()] || '';
      const r = await api(`/api/job-files/${d.id}`, { body: { action: 'upload-url', file_name: f.name, mime_type: mime, size: f.size, doc_type: 'correspondence', description: 'Shared in the team chat' } });
      const put = await fetch(r.upload.url, { method: 'PUT', headers: r.upload.headers, body: f });
      if (!put.ok) throw new Error('The file did not upload. Please try again.');
      const c = await api(`/api/job-files/${d.id}`, { body: { action: 'upload-confirm', ticket: r.ticket } });
      setBusy(false);
      await send(c.uploaded_document_id);
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  const saveEdit = async () => {
    if (!editing) return;
    try { merge([await api(`/api/job-files/${d.id}/chat/${editing.id}`, { method: 'PATCH', body: { body: editing.body } })]); setEditing(null); }
    catch (e: any) { setErr(e.message); }
  };

  return (
    <div className="panel chat">
      <div className="chat-head">
        <b>Team chat</b><span className="muted small">Internal only — never shown to customers or agents.</span><span className="spacer" />
        <div className="chat-people">{people.map((p) => <span key={p.id} className="chat-person" title={`${p.full_name} — ${p.role_name}`}><StatusDot s={p} /> {p.full_name.split(' ')[0]}</span>)}</div>
      </div>
      <div className="chat-list" aria-live="polite">
        {msgs.length === 0 && <p className="muted" style={{ textAlign: 'center', padding: 30 }}>No messages yet. Start the conversation for this shipment.</p>}
        {msgs.map((m) => (
          <div key={m.id} className={`chat-msg${m.mine ? ' mine' : ''}`}>
            <div className="chat-meta"><b>{m.mine ? 'You' : m.user_name}</b> · {fmtDateTime(m.created_at)}{m.edited_at && <span className="muted"> · corrected</span>}</div>
            {editing?.id === m.id ? <div className="chat-edit">
                <textarea value={editing?.body ?? ""} onChange={(e) => setEditing({ id: m.id, body: e.target.value })} rows={2} />
                <div><button className="btn small" onClick={() => setEditing(null)}>Cancel</button> <button className="btn small primary" onClick={saveEdit}>Save</button></div></div>
              : <div className="chat-bubble">{m.hidden ? <i className="muted">A message with prices — hidden for you</i> : m.body}
                {m.document && <div><a href={`/api/jf-files/${m.document.id}?view=1`} target="_blank" rel="noreferrer">📎 {m.document.file_name ?? 'Attached file'}</a></div>}</div>}
            <div className="chat-foot muted small">
              {m.mine && (() => { const s = reads.filter((x) => x.read_at >= m.created_at).map((x) => x.name);
                return s.length ? `✓✓ Seen by ${s.join(', ')}` : '✓ Sent'; })()}
              {m.can_edit && editing?.id !== m.id && <button className="linkish small" onClick={() => setEditing({ id: m.id, body: m.body })}>Correct</button>}
            </div>
          </div>))}
        <div ref={end} />
      </div>
      {err && <div className="msg err">{err}</div>}
      <div className="chat-compose">
        {pick && pick.list.length > 0 && <div className="chat-pick" role="listbox">{pick.list.map((u) => <button key={u.id} role="option" onClick={() => choose(u)}>{u.full_name}</button>)}</div>}
        <textarea rows={2} placeholder="Write a message… type @ to mention someone" value={text} onChange={(e) => onType(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !pick) { e.preventDefault(); send(); } }} aria-label="Message" />
        <div className="chat-actions">
          <input ref={file} type="file" hidden accept=".pdf,.jpg,.jpeg,.png,.xlsx,.xls,.docx,.doc,.eml,.msg" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) attach(f); }} />
          <button className="btn small" disabled={busy} onClick={() => file.current?.click()} title="Attach a file (saved with the job's documents)">Attach</button>
          <button className="btn small primary" disabled={busy || !text.trim()} onClick={() => send()}>Send</button>
        </div>
      </div>
    </div>
  );
}
