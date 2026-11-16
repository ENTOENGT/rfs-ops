'use client';
/** Release L (migration 027): "My chats" — every shipment I can open that has a team chat, newest first, with my unread count. */
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '@/components/api';

export default function Chats() {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [only, setOnly] = useState(false);
  useEffect(() => {
    const load = () => api('/api/chats').then(setD).catch((e) => setErr(e.message));
    load(); const t = setInterval(load, 20000); return () => clearInterval(t);
  }, []);
  const rows = (d?.rows ?? []).filter((r: any) => !only || r.unread > 0);
  return (
    <div className="page">
      <div className="page-head"><h1>Team chats</h1><span className="spacer" />
        <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto' }} checked={only} onChange={(e) => setOnly(e.target.checked)} /> Unread only</label></div>
      {err && <div className="msg err">{err}</div>}
      {!d ? <p className="muted">Loading…</p> : <div className="panel flush"><div className="table-wrap"><table className="t">
        <thead><tr><th>Shipment</th><th>Customer</th><th>Last message</th><th>When</th><th>Unread</th></tr></thead>
        <tbody>{rows.map((r: any) => (
          <tr key={r.id}><td><Link href={`/job-files/${r.id}?tab=chat`}><b>{r.job_no ?? r.enquiry_ref}</b></Link></td><td>{r.customer_name}</td>
            <td className="small"><b>{r.last_by}:</b> {r.last_body}</td><td className="small">{fmtDateTime(r.last_at)}</td>
            <td>{r.unread ? <span className="unread-pill">{r.unread}</span> : <span className="muted">—</span>}</td></tr>))}
          {rows.length === 0 && <tr><td colSpan={5} className="muted" style={{ padding: 24, textAlign: 'center' }}>{only ? 'No unread messages.' : 'No team chats yet. Open a shipment and use its Team chat tab.'}</td></tr>}
        </tbody></table></div></div>}
    </div>
  );
}
