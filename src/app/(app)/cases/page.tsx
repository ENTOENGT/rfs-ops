'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '@/components/api';
import { useMe } from '@/components/Shell';

const KINDS: [string, string][] = [['enquiry', 'Enquiry'], ['complaint', 'Complaint'], ['delay', 'Delay'], ['damage', 'Damage / loss'], ['documents', 'Documents'], ['other', 'Other']];
const CHANNELS: [string, string][] = [['phone', 'Phone'], ['email', 'Email'], ['whatsapp', 'WhatsApp'], ['walk_in', 'Walk-in'], ['portal', 'Portal'], ['other', 'Other']];

export default function Cases() {
  const { can, lk } = useMe();
  const router = useRouter();
  const [f, setF] = useState<Record<string, string>>({ status: 'active' });
  const [d, setD] = useState<any>(null);
  const [nw, setNw] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => { const t = setTimeout(() => api(`/api/cases?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`).then(setD).catch((e) => setErr(e.message)), 200); return () => clearTimeout(t); }, [f]);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const create = async () => { setErr(''); try { const k = await api('/api/cases', { body: nw }); router.push(`/cases/${k.id}`); } catch (e: any) { setErr(e.message); } };
  const tile = (key: string, label: string, n?: number) => <button className={`kpi${f.status === key ? ' on' : ''}`} onClick={() => setF({ ...f, status: f.status === key ? '' : key })}>
    <span className="kpi-n">{n ?? 0}</span><span className="kpi-l">{label}</span></button>;
  return (
    <div className="page">
      <div className="page-head"><h1>Customer service</h1><span className="spacer" />
        {can('cases.manage') && <button className="btn primary" onClick={() => setNw({ priority: 'normal', kind: 'enquiry', channel: 'phone' })}>New case</button>}</div>
      <div className="kpis pro-tiles">{tile('active', 'Open cases', d?.counts.active)}{tile('overdue', 'Past due time', d?.counts.overdue)}
        <button className={`kpi${f.mine === '1' ? ' on' : ''}`} onClick={() => setF({ ...f, mine: f.mine === '1' ? '' : '1' })}><span className="kpi-n">{d?.counts.unassigned ?? 0}</span><span className="kpi-l">Not assigned (click: my cases)</span></button></div>
      <div className="panel" style={{ margin: '12px 0' }}><div className="grid g4">
        <label className="f"><span>Search</span><input value={f.q ?? ''} onChange={set('q')} placeholder="Case no., subject, customer, Job No." /></label>
        <label className="f"><span>Customer</span><select value={f.customer_id ?? ''} onChange={set('customer_id')}><option value="">All</option>
          {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="f"><span>Type</span><select value={f.kind ?? ''} onChange={set('kind')}><option value="">All</option>{KINDS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>
        <label className="f"><span>Status</span><select value={f.status ?? ''} onChange={set('status')}><option value="">All</option><option value="active">Open (not resolved)</option>
          <option value="overdue">Past due time</option><option value="resolved">Resolved</option><option value="closed">Closed</option></select></label>
      </div></div>
      {err && <div className="msg err">{err}</div>}
      <div className="panel flush"><div className="table-wrap"><table className="t">
        <thead><tr><th>Case</th><th>Customer</th><th>Subject</th><th>Type</th><th>Owner</th><th>Due</th><th>Status</th></tr></thead>
        <tbody>{d?.rows.map((k: any) => <tr key={k.id}>
          <td><Link href={`/cases/${k.id}`}><b>{k.case_no}</b></Link>{k.priority !== 'normal' && <div className={k.priority === 'urgent' || k.priority === 'high' ? 'flag' : 'muted small'}>{k.priority}</div>}</td>
          <td>{k.customer_name}{k.job_no && <div className="muted small">{k.job_no}</div>}</td><td>{k.subject}</td><td className="small">{k.kind_name}</td>
          <td>{k.owner_name ?? <span className="flag">Not assigned</span>}</td>
          <td>{['resolved', 'closed'].includes(k.status) ? '—' : fmtDateTime(k.due_at)}{k.overdue && <div className="flag">Overdue</div>}</td>
          <td><span className="badge" style={{ background: k.status_color }}>{k.status_name}</span></td></tr>)}
          {d && d.rows.length === 0 && <tr><td colSpan={7} className="muted" style={{ padding: 24, textAlign: 'center' }}>No cases here.</td></tr>}</tbody></table></div></div>
      {nw && <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setNw(null)}><div className="modal" role="dialog" aria-label="New case" style={{ maxWidth: 720 }}>
        <h2>New customer service case</h2>
        {err && <div className="msg err">{err}</div>}
        <div className="grid g2">
          <label className="f"><span>Customer <em>*</em></span><select value={nw.customer_id ?? ''} onChange={(e) => setNw({ ...nw, customer_id: e.target.value })}><option value="">Choose customer</option>
            {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="f"><span>Job No. (if about a shipment)</span><input value={nw.job_no ?? ''} onChange={(e) => setNw({ ...nw, job_no: e.target.value })} /></label>
          <label className="f span2"><span>Subject <em>*</em></span><input value={nw.subject ?? ''} onChange={(e) => setNw({ ...nw, subject: e.target.value })} /></label>
          <label className="f"><span>Type</span><select value={nw.kind} onChange={(e) => setNw({ ...nw, kind: e.target.value })}>{KINDS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>
          <label className="f"><span>Priority</span><select value={nw.priority} onChange={(e) => setNw({ ...nw, priority: e.target.value })}>
            <option value="low">Low (3 days)</option><option value="normal">Normal (24 hours)</option><option value="high">High (8 hours)</option><option value="urgent">Urgent (4 hours)</option></select></label>
          <label className="f"><span>How they contacted us</span><select value={nw.channel} onChange={(e) => setNw({ ...nw, channel: e.target.value })}>{CHANNELS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>
          <label className="f"><span>Contact name / number</span><input value={nw.contact_name ?? ''} onChange={(e) => setNw({ ...nw, contact_name: e.target.value })} /></label>
          <label className="f span2"><span>Details</span><textarea rows={3} value={nw.description ?? ''} onChange={(e) => setNw({ ...nw, description: e.target.value })} /></label>
        </div>
        <div className="actions"><button className="btn" onClick={() => setNw(null)}>Cancel</button><button className="btn primary" onClick={create}>Open case</button></div>
      </div></div>}
    </div>
  );
}
