'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '@/components/api';
import { useMe } from '@/components/Shell';
import { JobFileFields } from '@/components/JobFileForm';
import { FormHints } from '@/components/FormHints';
import { CONTAINER_TYPES } from '@/lib/jobfileRules';
import { blankLine, typedLines } from '@/lib/cargoRules';

export default function NewJobFile() {
  const { can } = useMe();
  const router = useRouter();
  const [f, setF] = useState<any>({ mode: 'sea_fcl', status: 'enquiry', cargo_lines: [blankLine()] });
  const [conts, setConts] = useState<{ container_no: string; size_type: string; seal_no: string }[]>([{ container_no: '', size_type: '40HC', seal_no: '' }]);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [err, setErr] = useState<{ m: string; id?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  // migration 035: "Create enquiry" from an email — the AI fills the form (and a new customer); you check and save
  const [fromEmail, setFromEmail] = useState<string | null>(null);
  const [src, setSrc] = useState<any>(null);
  const [nc, setNc] = useState<any>(null);
  const [aiState, setAiState] = useState<'idle' | 'reading' | 'done' | 'error'>('idle');
  const [already, setAlready] = useState<any>(null);
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('from_email');
    if (!id) return;
    setFromEmail(id); setAiState('reading');
    api(`/api/outlook/inbox/${id}/draft`, { body: {} }).then((r) => {
      if (r.already) { setAlready(r.already); setAiState('done'); return; }
      const { new_customer, customer_name, summary, mode_unknown, attachments_read, attachments_notes, hs_codes, v, ai_notes, ...fields } = r.draft;
      const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== null && v !== undefined));
      setF((x: any) => ({ ...x, ...clean }));
      setNc(new_customer); setSrc({ ...r.email, summary, customer_name, mode_unknown, attachments_read, attachments_notes, notes: ai_notes }); setAiState('done');
    }).catch((e) => { setErr({ m: `The AI could not read the email: ${e.message} — you can still fill in the enquiry by hand.` }); setAiState('error'); });
  }, []);
  if (!can('jobfiles.create')) return <div className="page"><div className="msg err">You can't create Job Files.</div></div>;
  const containersNeeded = f.mode === 'sea_fcl' && f.status !== 'enquiry';
  const save = async () => {
    setErr(null); setFe({}); setBusy(true);
    try {
      const payload = { ...f, cargo_lines: typedLines(f.cargo_lines), containers: containersNeeded ? conts.filter((k) => k.container_no.trim()) : [] };
      const r = fromEmail && aiState === 'done'
        ? await api(`/api/outlook/inbox/${fromEmail}/enquiry`, { body: { enquiry: { ...payload, new_customer: undefined }, new_customer: f.customer_id ? null : (f.new_customer ?? nc) } })
        : await api('/api/job-files', { body: payload });
      router.push(`/job-files/${r.id}`);
    } catch (e: any) {
      setBusy(false);
      setErr({ m: e.message, id: e.code === 'JOB_FILE_EXISTS' ? e.details?.id : undefined });
      if (e.details?.fields) setFe(e.details.fields);
      window.scrollTo(0, 0);
    }
  };
  return (
    <div className="page">
      <div className="page-head"><h1>{f.status === 'enquiry' ? 'New enquiry' : 'New Job File'}</h1></div>
      {err && <div className="msg err">{err.m} {err.id && <Link href={`/job-files/${err.id}`}>Open it</Link>}</div>}
      {already && <div className="msg ok">This email is already enquiry <b>{already.enquiry_ref}</b>. <Link href={`/job-files/${already.id}`}>Open it</Link></div>}
      {aiState === 'reading' && <div className="ai-box"><div className="ai-head"><span className="ai-tag">AI</span><b>Reading the email and filling in the enquiry…</b></div></div>}
      {src && <div className="ai-box">
        <div className="ai-head"><span className="ai-tag">AI</span><b>Filled in from the email</b><span className="muted small">— check everything before you save.</span></div>
        <p className="small" style={{ margin: '6px 0' }}>From <b>{src.from_name || src.from_addr}</b> · {src.subject || '(no subject)'} · {fmtDateTime(src.received_at)}
          {src.web_link && <> · <a href={src.web_link} target="_blank" rel="noopener">Open in Outlook</a></>}</p>
        {src.summary && <p className="small" style={{ margin: '0 0 6px' }}>{src.summary}</p>}
        {src.attachments_read?.length > 0 && <p className="small" style={{ margin: '0 0 6px' }}>📎 Also read from the attachments: <b>{src.attachments_read.join(', ')}</b></p>}
        {src.attachments_notes?.length > 0 && <p className="small flag" style={{ margin: '0 0 6px' }}>📎 {src.attachments_notes.join(' · ')}</p>}
        {src.mode_unknown && <p className="small flag" style={{ margin: '0 0 6px' }}>The email doesn't say the mode — choose it below.</p>}
        {/* batch 1: what needs a look before quoting, why the services were ticked, remarks that change price / services */}
        {src.notes?.flags?.length > 0 && <div className="ai-flags">{src.notes.flags.map((t: string, i: number) => <p key={i} className="small">⚠ {t}</p>)}</div>}
        {src.notes?.remarks?.length > 0 && <div className="ai-remarks"><b className="small">Customer remarks that matter:</b>
          {src.notes.remarks.map((t: string, i: number) => <p key={i} className="small">• {t}</p>)}</div>}
        {src.notes?.services?.length > 0 && <details className="small" style={{ margin: '4px 0' }}><summary>Why these services were ticked</summary>
          {src.notes.services.map((t: string, i: number) => <p key={i} style={{ margin: '2px 0 0 12px' }}>{t}</p>)}</details>}
        {!f.customer_id && !f.new_customer && nc && <div className="grid g2" style={{ marginTop: 8 }}>
          <div className="span2 small"><b>New customer</b> — made when you save (the sender becomes the main contact, in To). Or choose an existing customer below instead.</div>
          <label className="f"><span>Company name <em>*</em></span><input value={nc.name ?? ''} onChange={(e) => setNc({ ...nc, name: e.target.value })} /></label>
          <label className="f"><span>Contact person</span><input value={nc.contact_person ?? ''} onChange={(e) => setNc({ ...nc, contact_person: e.target.value })} /></label>
          <label className="f"><span>Email</span><input value={nc.email ?? ''} onChange={(e) => setNc({ ...nc, email: e.target.value })} /></label>
          <label className="f"><span>Phone</span><input value={nc.contact_number ?? ''} onChange={(e) => setNc({ ...nc, contact_number: e.target.value })} /></label>
        </div>}
        {f.customer_id && src.customer_name && <p className="small" style={{ margin: 0 }}>Customer: <b>{src.customer_name}</b> (already in RFS CRM — found by the sender's email)</p>}
      </div>}
      <div className="panel"><h2>What is it?</h2><div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
        {[['enquiry', 'Customer enquiry — rates, quotation and booking first'], ['open', 'Operational job — Job No. from the ERP already given, no quotation needed']].map(([v, t]) =>
          <label key={v} className="check"><input type="radio" name="jf_kind" checked={f.status === v} onChange={() => setF({ ...f, status: v, direction: v === 'enquiry' ? f.direction : f.direction || 'import' })} /> {t}</label>)}</div>
        {f.status === 'enquiry' && <p className="muted small" style={{ marginBottom: 0 }}>The system gives it an Enquiry Ref now. The Shipping Ref comes when the customer confirms,
          and the Job No. from the ERP when the pre-alert is verified and the job is handed over to Operations — all on this one record.</p>}</div>
      {f.status === 'enquiry' && <FormHints f={f} setF={setF} />}
      <JobFileFields f={f} setF={(v) => { setF(v); setFe({}); }} fe={fe} isNew />
      {containersNeeded && <div className="panel"><h2>Containers</h2>
        <p className="muted small" style={{ marginTop: 0 }}>Optional now — they can be added later on the Job File.</p>
        {conts.map((k, i) => <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
          <input value={k.container_no} onChange={(e) => setConts(conts.map((x, j) => j === i ? { ...x, container_no: e.target.value.toUpperCase() } : x))} placeholder="Container no., e.g. MSCU1234566" style={{ flex: 2 }} />
          <select value={k.size_type} onChange={(e) => setConts(conts.map((x, j) => j === i ? { ...x, size_type: e.target.value } : x))} style={{ flex: 1 }}>
            {CONTAINER_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
          <input value={k.seal_no} onChange={(e) => setConts(conts.map((x, j) => j === i ? { ...x, seal_no: e.target.value } : x))} placeholder="Seal no." style={{ flex: 1 }} />
          <button className="btn small" type="button" onClick={() => setConts(conts.filter((_, j) => j !== i))} disabled={conts.length === 1}>✕</button></div>)}
        <button className="btn small" type="button" onClick={() => setConts([...conts, { container_no: '', size_type: conts[conts.length - 1]?.size_type ?? '40HC', seal_no: '' }])}>+ Add container</button>
      </div>}
      <div className="form-actions"><Link className="btn" href="/job-files">Cancel</Link>
        <button className="btn primary" disabled={busy || aiState === 'reading' || !!already} onClick={save}>{busy ? 'Saving…' : f.status === 'enquiry' ? (!f.customer_id && (f.new_customer || (fromEmail && nc)) ? 'Create customer and open enquiry' : 'Open enquiry') : 'Create Job File'}</button></div>
    </div>
  );
}
