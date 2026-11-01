'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '@/components/api';
import { useMe } from '@/components/Shell';

export default function Case({ params }: { params: { id: string } }) {
  const { lk } = useMe();
  const [d, setD] = useState<any>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => { api(`/api/cases/${params.id}`).then(setD).catch((e) => setErr(e.message)); }, [params.id]);
  const act = async (body: any) => { setErr(''); try { setD(await api(`/api/cases/${params.id}`, { body })); return true; } catch (e: any) { setErr(e.message); return false; } };
  if (!d) return <div className="page">{err ? <div className="msg err">{err}</div> : <p className="muted">Loading…</p>}</div>;
  const open = !['resolved', 'closed'].includes(d.status);
  const status = (s: string, extra: any = {}) => act({ what: 'status', status: s, ...extra });
  return (
    <div className="page">
      <div className="page-head"><h1>{d.case_no}</h1><span className="badge" style={{ background: d.status_color }}>{d.status_name}</span>{d.overdue && <span className="flag">Overdue</span>}<span className="spacer" />
        {d.can.manage && d.status === 'open' && <button className="btn" onClick={() => status('in_progress')}>Start working</button>}
        {d.can.manage && open && d.status !== 'waiting_customer' && <button className="btn" onClick={() => status('waiting_customer')}>Waiting for customer</button>}
        {d.can.manage && d.status === 'waiting_customer' && <button className="btn" onClick={() => status('in_progress')}>Customer replied</button>}
        {d.can.manage && open && <button className="btn primary" onClick={() => { const resolution = prompt('How was it resolved?'); if (resolution) status('resolved', { resolution }); }}>Resolve</button>}
        {d.can.manage && d.status === 'resolved' && <><button className="btn" onClick={() => status('in_progress')}>Reopen</button><button className="btn primary" onClick={() => status('closed')}>Close</button></>}
      </div>
      {err && <div className="msg err">{err}</div>}
      <div className="cols">
        <div>
          <div className="panel"><h2>{d.subject}</h2>{d.description && <p style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{d.description}</p>}
            {d.resolution && <div className="msg ok">Resolution: {d.resolution}</div>}</div>
          <div className="panel"><h2>Notes and history</h2>
            {d.can.manage && d.status !== 'closed' && <div style={{ display: 'flex', gap: 6, marginBottom: 10, flexWrap: 'wrap' }}>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was done / said…" style={{ flex: 1, minWidth: 200 }} />
              <button className="btn small" disabled={!note.trim()} onClick={async () => { if (await act({ what: 'note', note })) setNote(''); }}>Add note</button>
              <button className="btn small" disabled={!note.trim()} onClick={async () => { if (await act({ what: 'note', note, to_customer: true })) setNote(''); }}>Log reply to customer</button></div>}
            {[...d.events].reverse().map((e: any, i: number) => <div key={i} className="small" style={{ padding: '5px 0', borderTop: '1px solid var(--line-soft)' }}>
              <b>{e.title}</b>{e.details && <>: <span style={{ whiteSpace: 'pre-wrap' }}>{e.details}</span></>}<div className="muted">{fmtDateTime(e.at)} · {e.user_name}</div></div>)}
          </div>
        </div>
        <div><div className="panel"><h2>Case</h2><dl className="kv">
          <dt>Customer</dt><dd>{d.customer_name}</dd>
          <dt>Job File</dt><dd>{d.job_file_id ? <Link href={`/job-files/${d.job_file_id}`}>{d.job_no}</Link> : '—'}</dd>
          <dt>Type</dt><dd>{d.kind_name}</dd><dt>Channel</dt><dd>{d.channel_name}</dd>
          <dt>Contact</dt><dd>{[d.contact_name, d.contact_detail].filter(Boolean).join(' · ') || '—'}</dd>
          <dt>Priority</dt><dd>{d.can.manage && open ? <select style={{ width: 'auto' }} value={d.priority} onChange={(e) => act({ what: 'priority', priority: e.target.value })}>
            {['low', 'normal', 'high', 'urgent'].map((p) => <option key={p}>{p}</option>)}</select> : d.priority}</dd>
          <dt>Owner</dt><dd>{d.can.manage && open ? <select style={{ width: 'auto' }} value={d.owner_id ?? ''} onChange={(e) => e.target.value && act({ what: 'assign', owner_id: e.target.value })}>
            <option value="">Not assigned</option>{lk.users.map((u: any) => <option key={u.id} value={u.id}>{u.name}</option>)}</select> : d.owner_name ?? '—'}</dd>
          <dt>Opened</dt><dd>{fmtDateTime(d.created_at)} by {d.created_by_name}</dd>
          <dt>Due</dt><dd>{fmtDateTime(d.due_at)}{d.status === 'waiting_customer' && <div className="muted small">Clock paused while waiting</div>}</dd>
          <dt>First response</dt><dd>{fmtDateTime(d.first_response_at)}</dd><dt>Resolved</dt><dd>{fmtDateTime(d.resolved_at)}</dd>
        </dl></div></div>
      </div>
    </div>
  );
}
