'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { api, fmtDate, fmtDateTime, fmtMoney } from '@/components/api';
import { NewVendorRequest } from '@/components/NewVendorRequest';

const LABEL: Record<string, string> = { quoted: 'Vendor quoted', confirmed: 'Confirmed', in_progress: 'In progress', completed: 'Completed', disputed: 'Problem / dispute', cancelled: 'Cancel' };

export default function VendorRequest({ params }: { params: { id: string } }) {
  const [d, setD] = useState<any>(null);
  const [step, setStep] = useState<any>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [more, setMore] = useState(false);
  const router = useRouter();
  useEffect(() => { api(`/api/vendor-requests/${params.id}`).then(setD).catch((e) => setErr(e.message)); }, [params.id]);
  const act = async (body: any) => { setErr(''); try { setD(await api(`/api/vendor-requests/${params.id}`, { body })); setStep(null); return true; } catch (e: any) { setErr(e.message); return false; } };
  if (!d) return <div className="page">{err ? <div className="msg err">{err}</div> : <p className="muted">Loading…</p>}</div>;
  return (
    <div className="page">
      <div className="page-head"><h1>{d.request_no}</h1><span className="badge" style={{ background: d.status_color }}>{d.status_name}</span><span className="spacer" />
        {d.can.update && d.next.map((s: string) => <button key={s} className={`btn${s === 'cancelled' ? ' danger' : s === 'completed' ? ' primary' : ''}`}
          onClick={() => setStep({ status: s, vendor_reference: d.vendor_reference ?? '', quoted_cost: d.quoted_cost ?? '', rate_valid_until: d.rate_valid_until ?? '', note: '' })}>{LABEL[s]}</button>)}
        {d.can.update && d.service === 'rate' && d.job_file_id && <button className="btn" onClick={() => setMore(true)}>Ask more vendors</button>}</div>
      {d.cheaper_warning && <div className="msg warn"><b>Another vendor gave a lower price.</b> {d.cheaper_warning}</div>}
      {err && <div className="msg err">{err}</div>}
      {step && <div className="panel"><h2>{LABEL[step.status]}</h2><div className="grid g3">
        {['quoted', 'confirmed'].includes(step.status) && <label className="f"><span>Vendor reference (quote / booking no.)</span><input value={step.vendor_reference} onChange={(e) => setStep({ ...step, vendor_reference: e.target.value })} /></label>}
        {['quoted', 'confirmed'].includes(step.status) && d.can.cost && <label className="f"><span>Vendor price ({d.currency})</span><input value={step.quoted_cost} onChange={(e) => setStep({ ...step, quoted_cost: e.target.value })} inputMode="decimal" /></label>}
        {['quoted', 'confirmed'].includes(step.status) && d.service === 'rate' && <label className="f"><span>Rate valid until</span><input type="date" value={step.rate_valid_until} onChange={(e) => setStep({ ...step, rate_valid_until: e.target.value })} /></label>}
        {['completed', 'disputed', 'cancelled'].includes(step.status) && <label className="f span2"><span>{step.status === 'completed' ? 'What was done and the proof' : step.status === 'disputed' ? 'What went wrong' : 'Reason'} <em>*</em></span>
          <textarea rows={2} value={step.note} onChange={(e) => setStep({ ...step, note: e.target.value })} /></label>}
      </div>
      {step.status === 'confirmed' && d.cheaper_warning && <div className="msg warn">You are choosing a vendor who is not the cheapest. {d.cheaper_warning} You can still confirm; it is noted in the history.</div>}
      <div className="form-actions"><button className="btn" onClick={() => setStep(null)}>Back</button>
        <button className="btn primary" onClick={() => act({ ...step, quoted_cost: d.can.cost ? step.quoted_cost : undefined, rate_valid_until: d.service === 'rate' ? step.rate_valid_until : undefined })}>
          {step.status === 'confirmed' && d.cheaper_warning ? 'Confirm anyway' : 'Save'}</button></div></div>}
      {d.compare && <div className="panel flush"><h2 style={{ padding: '12px 14px 0' }}>Price comparison — same request to {d.compare.length} vendors</h2>
        <div className="table-wrap"><table className="t"><thead><tr><th>Request</th><th>Vendor</th><th className="num">Price</th><th>Valid until</th><th>Status</th></tr></thead>
          <tbody>{d.compare.map((r: any) => <tr key={r.id} className={r.lowest ? 'is-lowest' : ''}>
            <td>{r.id === d.id ? <b>{r.request_no} (this)</b> : <Link href={`/vendor-requests/${r.id}`}>{r.request_no}</Link>}</td>
            <td>{r.vendor_name}{r.lowest && <span className="lowest">Lowest</span>}</td>
            <td className="num">{r.quoted_cost ? fmtMoney(r.quoted_cost, r.currency) : <span className="muted">waiting</span>}</td>
            <td>{fmtDate(r.rate_valid_until)}{r.expired && <div className="flag">Expired</div>}</td><td className="small">{r.status === 'cancelled' ? 'Cancelled' : r.status === 'requested' ? 'Waiting for price' : r.status === 'quoted' ? 'Quoted' : r.status}</td></tr>)}</tbody></table></div></div>}
      {more && <NewVendorRequest sameAs={{ id: d.id, asked: d.compare ? d.compare.filter((r: any) => r.status !== 'cancelled').map((r: any) => r.vendor_id) : [d.vendor_id] }} onClose={() => setMore(false)} onDone={(r) => { setMore(false); router.refresh(); api(`/api/vendor-requests/${params.id}`).then(setD); }} />}
      <div className="cols">
        <div>
          <div className="panel"><h2>Request</h2><p style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{d.description}</p>
            {d.completion_note && <div className="msg ok">Completed: {d.completion_note}</div>}{d.issue_note && <div className="msg warn">Problem: {d.issue_note}</div>}
            {d.cancel_reason && <div className="msg">Cancelled: {d.cancel_reason}</div>}</div>
          <div className="panel"><h2>History</h2>
            {d.can.update && <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…" style={{ flex: 1 }} />
              <button className="btn small" disabled={!note.trim()} onClick={async () => { if (await act({ what: 'note', note })) setNote(''); }}>Add</button></div>}
            {[...d.events].reverse().map((e: any, i: number) => <div key={i} className="small" style={{ padding: '5px 0', borderTop: '1px solid var(--line-soft)' }}>
              <b>{e.title}</b>{e.details && <>: {e.details}</>}<div className="muted">{fmtDateTime(e.at)} · {e.user_name}</div></div>)}</div>
        </div>
        <div><div className="panel"><h2>Details</h2><dl className="kv">
          <dt>Vendor</dt><dd>{d.vendor_name}{(d.vendor_contact || d.vendor_phone || d.vendor_email) && <div className="muted small">{[d.vendor_contact, d.vendor_phone, d.vendor_email].filter(Boolean).join(' · ')}</div>}</dd>
          <dt>Service</dt><dd>{d.service_name}</dd><dt>Job File</dt><dd>{d.job_file_id ? <Link href={`/job-files/${d.job_file_id}`}>{d.job_no}</Link> : '—'}</dd>
          <dt>Needed by</dt><dd>{fmtDate(d.needed_by)}</dd><dt>Vendor ref.</dt><dd>{d.vendor_reference ?? '—'}</dd>
          {d.can.cost && <><dt>Vendor price</dt><dd>{d.quoted_cost ? fmtMoney(d.quoted_cost, d.currency) : '—'}</dd></>}
          {d.service === 'rate' && <><dt>Rate valid until</dt><dd>{fmtDate(d.rate_valid_until)}</dd></>}
          <dt>Confirmed</dt><dd>{fmtDateTime(d.confirmed_at)}</dd><dt>Completed</dt><dd>{fmtDateTime(d.completed_at)}</dd>
          <dt>Requested by</dt><dd>{d.created_by_name}, {fmtDateTime(d.created_at)}</dd>
        </dl></div></div>
      </div>
    </div>
  );
}
