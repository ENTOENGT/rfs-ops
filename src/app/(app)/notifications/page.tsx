'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '@/components/api';

const hrefOf = (r: any) => r.case_id ? `/cases/${r.case_id}` : r.job_file_id ? `/job-files/${r.job_file_id}` : r.quotation_id ? `/quotations/${r.quotation_id}`
  : r.vendor_request_id ? `/vendor-requests/${r.vendor_request_id}` : r.pro_id ? `/pro/${r.pro_id}` : r.run_id ? `/runs/${r.run_id}` : r.job_id ? `/jobs/${r.job_id}` : null;

/** Every notification you were sent: read / unread, filter by event, open the shipment, and choose which events you also want by email. */
export default function Notifications() {
  const [f, setF] = useState({ unread: '', event: '', page: 1 });
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [prefs, setPrefs] = useState(false);
  const load = () => api(`/api/notifications?${new URLSearchParams({ page: String(f.page), unread: f.unread, event: f.event })}`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [f]); // eslint-disable-line react-hooks/exhaustive-deps
  const read = async (ids?: string[]) => { await api('/api/notifications', { body: { ids } }); load(); };
  const setPref = async (event: string, email: boolean) => {
    try { await api('/api/notifications/prefs', { body: { event, email } }); setD({ ...d, email_prefs: { ...d.email_prefs, [event]: email } }); } catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="page">
      <div className="page-head"><h1>Notifications</h1>{d && <span className="muted">{d.unread} unread of {d.total}</span>}<span className="spacer" />
        <button className="btn" onClick={() => setPrefs(!prefs)}>{prefs ? 'Back to the list' : 'Email settings'}</button>
        {d?.unread > 0 && !prefs && <button className="btn" onClick={() => read()}>Mark all as read</button>}</div>
      {err && <div className="msg err">{err}</div>}
      {prefs && d ? <div className="panel"><h2>Also send me an email for…</h2>
        <p className="muted small" style={{ marginTop: 0 }}>Everything always shows here. Email copies start once the company mailbox is connected to RFS Ops (Part G3); your choices are saved now.</p>
        <div className="grid g3">{d.events.map(([k, n]: [string, string]) => <label key={k} className="check">
          <input type="checkbox" checked={!!d.email_prefs[k]} onChange={(e) => setPref(k, e.target.checked)} /> {n}</label>)}</div>
      </div> : <>
        <div className="filters" style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 10 }}>
          <select value={f.unread} onChange={(e) => setF({ ...f, unread: e.target.value, page: 1 })} aria-label="Read or unread" style={{ width: 'auto' }}>
            <option value="">All</option><option value="1">Unread only</option></select>
          <select value={f.event} onChange={(e) => setF({ ...f, event: e.target.value, page: 1 })} aria-label="Event" style={{ width: 'auto' }}>
            <option value="">Every event</option>{d?.events.map(([k, n]: [string, string]) => <option key={k} value={k}>{n}</option>)}</select>
        </div>
        <div className="table-wrap"><table className="t"><thead><tr><th>When</th><th>What happened</th><th>By</th><th /></tr></thead>
          <tbody>{d?.rows.map((r: any) => { const href = hrefOf(r); return <tr key={r.id} style={r.read_at ? undefined : { fontWeight: 600 }}>
            <td className="small" style={{ whiteSpace: 'nowrap' }}>{fmtDateTime(r.created_at)}</td>
            <td>{href ? <Link href={href} onClick={() => !r.read_at && read([r.id])}>{r.title}</Link> : r.title}
              {r.event_name && <div className="muted small" style={{ fontWeight: 400 }}>{r.event_name}</div>}</td>
            <td className="small" style={{ fontWeight: 400 }}>{r.actor_name ?? ''}</td>
            <td style={{ whiteSpace: 'nowrap' }}>{r.read_at ? <span className="muted small" style={{ fontWeight: 400 }}>read {fmtDateTime(r.read_at)}</span>
              : <button className="linkish" onClick={() => read([r.id])}>Mark read</button>}</td></tr>; })}
            {d?.rows.length === 0 && <tr><td colSpan={4} className="muted">Nothing here.</td></tr>}</tbody></table></div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          {f.page > 1 && <button className="btn small" onClick={() => setF({ ...f, page: f.page - 1 })}>Newer</button>}
          {d?.more && <button className="btn small" onClick={() => setF({ ...f, page: f.page + 1 })}>Older</button>}</div>
      </>}
    </div>
  );
}
