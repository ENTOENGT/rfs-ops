'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/components/api';
import { useMe } from '@/components/Shell';
import { JobFileFields } from '@/components/JobFileForm';
import { CONTAINER_TYPES } from '@/lib/jobfileRules';

export default function NewJobFile() {
  const { can } = useMe();
  const router = useRouter();
  const [f, setF] = useState<any>({ direction: 'import', mode: 'sea_fcl', status: 'enquiry' });
  const [conts, setConts] = useState<{ container_no: string; size_type: string; seal_no: string }[]>([{ container_no: '', size_type: '40HC', seal_no: '' }]);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [err, setErr] = useState<{ m: string; id?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  if (!can('jobfiles.create')) return <div className="page"><div className="msg err">You can't create Job Files.</div></div>;
  const containersNeeded = f.mode === 'sea_fcl' && f.status !== 'enquiry';
  const save = async () => {
    setErr(null); setFe({}); setBusy(true);
    try {
      const r = await api('/api/job-files', { body: { ...f, containers: containersNeeded ? conts.filter((k) => k.container_no.trim()) : [] } });
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
      <div className="panel"><h2>What is it?</h2><div style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}>
        {[['enquiry', 'Customer enquiry — rates, quotation and booking first'], ['open', 'Operational job — Job No. from the ERP already given, no quotation needed']].map(([v, t]) =>
          <label key={v} className="check"><input type="radio" name="jf_kind" checked={f.status === v} onChange={() => setF({ ...f, status: v })} /> {t}</label>)}</div>
        {f.status === 'enquiry' && <p className="muted small" style={{ marginBottom: 0 }}>The system gives it an Enquiry Ref now. The Shipping Ref comes when the customer confirms,
          and the Job No. from the ERP when the pre-alert is verified and the job is handed over to Operations — all on this one record.</p>}</div>
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
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : f.status === 'enquiry' ? 'Open enquiry' : 'Create Job File'}</button></div>
    </div>
  );
}
