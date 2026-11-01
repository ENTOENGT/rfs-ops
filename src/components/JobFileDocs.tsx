'use client';
import { useState } from 'react';
import { api, fmtDate, fmtDateTime } from './api';
import { FileViewer, shrinkImage, fmtSize } from './JobFiles';

const STATUS: Record<string, [string, string]> = {
  missing: ['Missing', '#C05621'], pending: ['Waiting for approval', '#B7791F'], approved: ['Approved', '#2F855A'],
  rejected: ['Rejected', '#9B2C2C'], waived: ['Not needed', '#6B7280'],
};
const EXTRA: [string, string][] = [['insurance', 'Insurance certificate'], ['permit', 'Permit / licence'], ['photo', 'Cargo photo'],
  ['correspondence', 'Customer / agent correspondence'], ['other', 'Other']];

/** Job File documents: the checklist of required documents, uploads with versions, approve / reject, waive. */
export default function JobFileDocs({ d, onChange, onError }: { d: any; onChange: (v: any) => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState('');
  const [view, setView] = useState<number | null>(null);
  const [extraType, setExtraType] = useState('other');
  const current = d.documents.filter((x: any) => !x.replaced_at);
  const nameOf = (t: string) => d.checklist.find((c: any) => c.doc_type === t)?.name ?? EXTRA.find(([c]) => c === t)?.[1] ?? t;
  const act = async (body: any) => { try { onChange(await api(`/api/job-files/${d.id}`, { body: { action: 'document', ...body } })); } catch (e: any) { onError(e.message); } };
  const upload = async (docType: string, file: File, replaces?: string) => {
    setBusy(`Uploading ${file.name}…`);
    try {
      const f = await shrinkImage(file);
      const mime = f.type || (/\.pdf$/i.test(f.name) ? 'application/pdf' : '');
      const r = await api(`/api/job-files/${d.id}`, { body: { action: 'upload-url', file_name: f.name, mime_type: mime, size: f.size, doc_type: docType, replaces_id: replaces } });
      const put = await fetch(r.upload.url, { method: 'PUT', headers: r.upload.headers, body: f });
      if (!put.ok) throw new Error(`Upload failed (${put.status}). Please try again.`);
      onChange(await api(`/api/job-files/${d.id}`, { body: { action: 'upload-confirm', ticket: r.ticket } }));
    } catch (e: any) { onError(e.message); }
    setBusy('');
  };
  const pick = (docType: string, replaces?: string) => {
    const i = document.createElement('input');
    i.type = 'file'; i.accept = '.pdf,.jpg,.jpeg,.png,.xlsx,.docx';
    i.onchange = () => { if (i.files?.[0]) upload(docType, i.files[0], replaces); };
    i.click();
  };
  const files = current.map((x: any) => ({ id: x.id, file_name: x.file_name, mime_type: x.mime_type, size_bytes: x.size_bytes }));
  const open = (id: string) => setView(current.findIndex((x: any) => x.id === id));
  const docRow = (x: any) => <div key={x.id} className="small" style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', padding: '3px 0 3px 12px' }}>
    <button className="linkish" onClick={() => open(x.id)}>{x.file_name}</button>
    <span className="muted">v{x.version} · {fmtSize(x.size_bytes)} · {x.uploaded_by_name}, {fmtDateTime(x.created_at)}{x.expiry_date && ` · expires ${fmtDate(x.expiry_date)}`}</span>
    <span className="badge" style={{ background: STATUS[x.status][1] }}>{STATUS[x.status][0]}</span>
    {x.review_note && <span className="muted">“{x.review_note}”</span>}
    <span className="spacer" />
    {d.can.approve_docs && x.status !== 'approved' && <button className="btn small" onClick={() => act({ what: 'approve', document_id: x.id })}>Approve</button>}
    {d.can.approve_docs && x.status !== 'rejected' && <button className="btn small" onClick={() => { const note = prompt('What is wrong with it?'); if (note) act({ what: 'reject', document_id: x.id, note }); }}>Reject</button>}
    {d.can.upload && <button className="btn small" onClick={() => pick(x.doc_type, x.id)}>Replace</button>}
    {(d.can.upload || d.can.approve_docs) && <button className="linkish" onClick={() => confirm(`Remove ${x.file_name}? It stays in the history.`) && act({ what: 'remove', document_id: x.id })}>Remove</button>}
  </div>;
  const required = new Set(d.checklist.map((c: any) => c.doc_type));
  const extras = current.filter((x: any) => !required.has(x.doc_type));
  const missing = d.checklist.filter((c: any) => ['missing', 'rejected'].includes(c.status)).length;
  return (
    <div className="panel"><h2>Documents {missing > 0 && <span className="flag">{missing} missing</span>}</h2>
      {busy && <div className="msg">{busy}</div>}
      {d.checklist.map((c: any) => <div key={c.doc_type} style={{ borderTop: '1px solid var(--line-soft)', padding: '6px 0' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <b className="small">{c.name}</b><span className="badge" style={{ background: STATUS[c.status][1] }}>{STATUS[c.status][0]}</span>
          {c.waiver && <span className="muted small">{c.waiver.reason} — {c.waiver.waived_by_name}</span>}
          <span className="spacer" />
          {d.can.upload && c.status !== 'waived' && !current.some((x: any) => x.doc_type === c.doc_type) && <button className="btn small primary" onClick={() => pick(c.doc_type)}>Upload</button>}
          {d.can.approve_docs && c.status === 'missing' && <button className="btn small" onClick={() => { const reason = prompt(`Why is "${c.name}" not needed for this Job File?`); if (reason) act({ what: 'waive', doc_type: c.doc_type, reason }); }}>Not needed</button>}
          {d.can.approve_docs && c.status === 'waived' && <button className="linkish small" onClick={() => act({ what: 'unwaive', doc_type: c.doc_type })}>Needed again</button>}
        </div>
        {current.filter((x: any) => x.doc_type === c.doc_type).map(docRow)}
      </div>)}
      {extras.length > 0 && <div style={{ borderTop: '1px solid var(--line-soft)', padding: '6px 0' }}><b className="small">Other documents</b>
        {extras.map((x: any) => <div key={x.id}><span className="muted small" style={{ paddingLeft: 12 }}>{nameOf(x.doc_type)}</span>{docRow(x)}</div>)}</div>}
      {d.can.upload && <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <select value={extraType} onChange={(e) => setExtraType(e.target.value)} style={{ flex: 1 }}>{EXTRA.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select>
        <button className="btn small" onClick={() => pick(extraType)}>Add other document</button></div>}
      <p className="muted small" style={{ marginBottom: 0 }}>{d.docs_required_to_close ? 'The Job File can close once every required document is approved or marked not needed.' : 'Documents are not required to close (Settings).'}
        {' '}PDF, JPG, PNG, Excel or Word, up to 10 MB. Replacing keeps the older version.</p>
      {view !== null && view >= 0 && <FileViewer files={files} start={view} base={(id) => `/api/jf-files/${id}`} onClose={() => setView(null)} />}
    </div>
  );
}
