'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime, fmtMoney } from '@/components/api';
import { EmailButton } from '@/components/EmailButton';
import { useMe } from '@/components/Shell';
import { JobFileFields } from '@/components/JobFileForm';
import JobFileDocs from '@/components/JobFileDocs';
import { CONTAINER_TYPES, JF_STATUSES, label, DIRECTIONS, MODES } from '@/lib/jobfileRules';
import { StageHeader, RatesAndQuotes, BookingPanel, PrealertPanel, HandoverPanel, LclPanel } from '@/components/CommercialPanels';

const RUN_STATUS: Record<string, string> = { pending: 'Waiting', assigned: 'Assigned', collected: 'Collected', delivered: 'Delivered', failed: 'Could not complete', cancelled: 'Cancelled' };
const EDIT_KEYS = ['customer_id', 'direction', 'mode', 'needs_clearance', 'needs_transport', 'needs_warehouse', 'customer_reference', 'shipper', 'consignee',
  'notify_party', 'origin', 'destination', 'port_of_loading', 'port_of_discharge', 'carrier', 'vessel_flight', 'voyage', 'booking_reference', 'mbl_mawb',
  'hbl_hawb', 'incoterm', 'etd', 'eta', 'atd', 'ata', 'packages', 'gross_weight_kg', 'volume_cbm', 'chargeable_weight_kg', 'cargo_description', 'remarks'];

function Milestones({ d, act }: { d: any; act: (b: any) => Promise<void> }) {
  const [planned, setPlanned] = useState<Record<string, string>>({});
  return (
    <div className="panel"><h2>Milestones</h2>
      <div className="table-wrap"><table className="t">
        <thead><tr><th>Step</th><th>Planned</th><th>Actual</th><th>Remarks</th>{d.can.edit && <th />}</tr></thead>
        <tbody>{d.milestones.map((m: any) => <tr key={m.id}>
          <td>{m.actual_at ? '✓ ' : ''}<b>{m.name}</b></td>
          <td>{d.can.edit ? <input type="date" style={{ width: 150 }} value={planned[m.id] ?? m.planned_date ?? ''}
            onChange={(e) => setPlanned({ ...planned, [m.id]: e.target.value })}
            onBlur={(e) => e.target.value !== (m.planned_date ?? '') && act({ action: 'milestone', milestone_id: m.id, planned_date: e.target.value })} /> : fmtDate(m.planned_date)}</td>
          <td>{m.actual_at ? <>{fmtDateTime(m.actual_at)}<div className="muted small">{m.updated_by_name}</div></> : <span className="muted">—</span>}</td>
          <td className="small">{m.remarks ?? ''}</td>
          {d.can.edit && <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
            {m.actual_at
              ? <button className="btn small" onClick={() => confirm(`Mark "${m.name}" as not done?`) && act({ action: 'milestone', milestone_id: m.id, done: false })}>Undo</button>
              : <button className="btn small primary" onClick={() => {
                  const remarks = prompt(`"${m.name}" done now. Remarks (optional):`, '');
                  if (remarks !== null) act({ action: 'milestone', milestone_id: m.id, done: true, remarks });
                }}>Done</button>}</td>}
        </tr>)}</tbody></table></div>
      <p className="muted small" style={{ marginBottom: 0 }}>Marking departure or arrival done also fills the actual departure / arrival date.</p>
    </div>
  );
}

export default function JobFile({ params }: { params: { id: string } }) {
  const { can } = useMe();
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [edit, setEdit] = useState<any>(null);
  const [cont, setCont] = useState({ container_no: '', size_type: '40HC', seal_no: '' });
  const [note, setNote] = useState('');
  const load = () => api(`/api/job-files/${params.id}`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [params.id]);
  const act = async (b: any, done?: string) => {
    setErr(''); setOk('');
    try { setD(await api(`/api/job-files/${params.id}`, { body: b })); if (done) setOk(done); }
    catch (e: any) { setErr(e.message); window.scrollTo(0, 0); }
  };
  const saveEdit = async () => {
    setErr('');
    try { setD(await api(`/api/job-files/${params.id}`, { method: 'PATCH', body: Object.fromEntries(EDIT_KEYS.map((k) => [k, edit[k] ?? null])) })); setEdit(null); setOk('Saved'); }
    catch (e: any) { setErr(e.message); window.scrollTo(0, 0); }
  };
  if (!d) return <div className="page">{err ? <div className="msg err">{err}</div> : <p className="muted">Loading…</p>}</div>;
  const active = JF_STATUSES.filter(([c]) => !['closed', 'cancelled'].includes(c));
  const open = !['closed', 'cancelled'].includes(d.status);
  const kv = (k: string, v: any) => <><dt>{k}</dt><dd>{v || v === 0 ? v : '—'}</dd></>;
  const commercialPanels = <>
    <HandoverPanel d={d} act={act} />
    <PrealertPanel d={d} act={act} onError={(m) => { setErr(m); window.scrollTo(0, 0); }} />
    <BookingPanel d={d} act={act} />
    {(d.status === 'enquiry' || (d.quotations?.length ?? 0) > 0 || (d.vendor_requests?.length ?? 0) > 0) && <RatesAndQuotes d={d} reload={load} />}
  </>;
  return (
    <div className="page">
      <div className="page-head">
        <h1>{d.status === 'enquiry' || (d.status === 'cancelled' && !d.job_no) ? `Enquiry ${d.enquiry_ref}` : `Job ${d.job_no}`}</h1>
        {d.status === 'enquiry' ? <span className="badge" style={{ background: d.stage_color }}>{d.stage_name}</span>
          : <span className="badge" style={{ background: d.status_color }}>{d.status_name}</span>}
        <span className="spacer" />
        {d.can.status && open && d.status !== 'enquiry' && <select value={d.status} onChange={(e) => act({ action: 'status', status: e.target.value }, 'Status changed')} style={{ width: 'auto' }} aria-label="Status">
          {active.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select>}
        {d.can.edit && !edit && d.status !== 'enquiry' && d.status !== 'cancelled' && <EmailButton kind="job_file" id={d.id} label="Email customer" onLogged={load} />}
        {d.can.edit && !edit && <button className="btn" onClick={() => setEdit({ ...d })}>Edit</button>}
        {d.can.lost && <button className="btn" onClick={() => { const reason = prompt('Mark this enquiry as lost? Give the reason:'); if (reason) act({ action: 'lost', reason }, 'Marked as lost'); }}>Lost</button>}
        {d.can.close && open && d.status !== 'enquiry' && <button className="btn primary" disabled={!d.closure.can_close} title={d.closure.can_close ? '' : 'See "Before it can close"'}
          onClick={() => confirm(`Close Job ${d.job_no}?`) && act({ action: 'status', status: 'closed' }, 'Job File closed')}>Close Job File</button>}
        {d.can.close && d.status === 'closed' && <button className="btn" onClick={() => {
          const reason = prompt('Why reopen it?'); if (reason) act({ action: 'status', status: 'delivering', reason }, 'Reopened'); }}>Reopen</button>}
        {d.can.close && open && <button className="btn danger" onClick={() => {
          const reason = prompt('Cancel this Job File? Give a reason:'); if (reason) act({ action: 'status', status: 'cancelled', reason }, 'Cancelled'); }}>Cancel</button>}
      </div>
      {err && <div className="msg err">{err}</div>}
      {ok && <div className="msg ok">{ok}</div>}
      {d.status === 'cancelled' && <div className="msg warn">Cancelled: {d.cancel_reason}</div>}
      {d.service_instructions && <div className="msg">Customer's standing instructions: {d.service_instructions}</div>}

      {!edit && <StageHeader d={d} />}
      {/* while in Commercials these come first; once handed over they move below the operational sections */}
      {!edit && d.status === 'enquiry' && commercialPanels}
      {edit ? <>
        <JobFileFields f={edit} setF={setEdit} />
        <div className="form-actions"><button className="btn" onClick={() => setEdit(null)}>Cancel</button>
          <button className="btn primary" onClick={saveEdit}>Save changes</button></div>
      </> : <div className="cols">
        <div>
          <div className="panel"><h2>Shipment</h2><dl className="kv">
            {kv('Customer', d.customer_name)}{kv('Type', `${label(DIRECTIONS, d.direction)} · ${label(MODES, d.mode)}`)}
            {kv('Services', [d.needs_clearance && 'Customs clearance', d.needs_transport && 'Transport', d.needs_warehouse && 'Warehouse'].filter(Boolean).join(', '))}
            {kv('Customer reference', d.customer_reference)}{kv('Incoterm', d.incoterm)}
            {kv('Shipper', d.shipper)}{kv('Consignee', d.consignee)}{kv('Notify party', d.notify_party)}
            {kv('Route', [d.origin, d.port_of_loading, d.port_of_discharge, d.destination].filter(Boolean).join(' → '))}
            {kv('Carrier', [d.carrier, d.vessel_flight, d.voyage].filter(Boolean).join(' · '))}
            {kv('Booking ref.', d.booking_reference)}{kv(d.mode === 'air' ? 'MAWB / HAWB' : 'MBL / HBL', [d.mbl_mawb, d.hbl_hawb].filter(Boolean).join(' / '))}
            {kv('ETD / actual', `${fmtDate(d.etd)} / ${fmtDate(d.atd)}`)}{kv('ETA / actual', `${fmtDate(d.eta)} / ${fmtDate(d.ata)}`)}
            {kv('Cargo', [d.packages && `${d.packages} pkgs`, d.gross_weight_kg && `${Number(d.gross_weight_kg).toLocaleString()} kg`,
              d.volume_cbm && `${d.volume_cbm} CBM`, d.chargeable_weight_kg && `chargeable ${Number(d.chargeable_weight_kg).toLocaleString()} kg`].filter(Boolean).join(' · '))}
            {kv('Description', d.cargo_description)}{kv('Remarks', d.remarks)}
            {kv('Department', d.department_name)}{kv('Created', `${fmtDateTime(d.created_at)} by ${d.created_by_name}`)}
            {d.quotation && kv('Quotation', <Link href={`/quotations/${d.quotation.id}`}>{d.quotation.quote_no}</Link>)}
          </dl></div>
          <JobFileDocs d={d} onChange={(v) => { setD(v); setErr(''); }} onError={(m) => { setErr(m); window.scrollTo(0, 0); }} />
          <Milestones d={d} act={act} />
          <div className="panel"><h2>Containers</h2>
            {d.containers.length === 0 && <p className="muted small">No containers.</p>}
            {d.containers.map((k: any) => <div key={k.id} className="small" style={{ display: 'flex', gap: 10, alignItems: 'center', padding: '4px 0' }}>
              <b>{k.container_no}</b><span>{k.size_type}</span>{k.seal_no && <span className="muted">seal {k.seal_no}</span>}<span className="spacer" />
              {d.can.edit && <button className="linkish" onClick={() => confirm(`Remove ${k.container_no}?`) && act({ action: 'container', remove: true, container_id: k.id })}>Remove</button>}
            </div>)}
            {d.can.edit && <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
              <input value={cont.container_no} onChange={(e) => setCont({ ...cont, container_no: e.target.value.toUpperCase() })} placeholder="Container no." style={{ flex: 2 }} />
              <select value={cont.size_type} onChange={(e) => setCont({ ...cont, size_type: e.target.value })} style={{ flex: 1 }}>{CONTAINER_TYPES.map((t) => <option key={t}>{t}</option>)}</select>
              <input value={cont.seal_no} onChange={(e) => setCont({ ...cont, seal_no: e.target.value })} placeholder="Seal no." style={{ flex: 1 }} />
              <button className="btn small" disabled={!cont.container_no.trim()} onClick={async () => { await act({ action: 'container', ...cont }); setCont({ ...cont, container_no: '', seal_no: '' }); }}>Add</button>
            </div>}
          </div>
        </div>
        <div>
          {d.mode === 'sea_lcl' && <LclPanel d={d} />}
          {open && d.status !== 'enquiry' && <div className={`panel${d.closure.can_close ? '' : ' warnbox'}`}><h2>Before it can close</h2>
            {d.closure.can_close ? <p className="small" style={{ margin: 0 }}>✓ All linked work is finished. It can be closed.</p>
              : <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>{d.closure.blockers.map((b: string) => <li key={b}>{b}</li>)}</ul>}
            {d.closure.warnings.length > 0 && <p className="muted small" style={{ marginBottom: 0 }}>Not blocking: {d.closure.warnings.length} milestone(s) without an actual date.</p>}
          </div>}
          <div className="panel"><h2>Truck trips</h2>
            {d.trips.length === 0 && <p className="muted small">None yet.{d.needs_transport && ' Transport is needed for this shipment.'}</p>}
            {d.trips.map((t: any) => <div key={t.id} className="small" style={{ padding: '4px 0' }}>
              <Link href={`/jobs/${t.id}`}><b>{t.job_number}</b></Link> <span className="badge" style={{ background: t.status_color }}>{t.status_name}</span>
              <div className="muted">{fmtDate(t.required_date)} · {t.pickup_name} → {t.delivery_name}</div></div>)}
            {d.can.request_transport && d.job_no && <p className="small" style={{ marginBottom: 0 }}><Link href="/requests/new">New transport request</Link> — type Job No. <b>{d.job_no}</b> and it appears here.</p>}
          </div>
          <div className="panel"><h2>PRO / customs clearance</h2>
            {d.pro.length === 0 && <p className="muted small">None yet.{d.needs_clearance && ' Clearance is needed for this shipment.'}</p>}
            {d.pro.map((r: any) => <div key={r.id} className="small" style={{ padding: '4px 0' }}>
              <Link href={`/pro/${r.id}`}><b>{r.request_no}</b></Link> <span className="badge" style={{ background: r.status_color }}>{r.status_name}</span>
              <div className="muted">{r.uae_location} · required {fmtDate(r.required_date)}</div></div>)}
            {d.can.request_pro && d.job_no && <p className="small" style={{ marginBottom: 0 }}><Link href="/pro/new">New PRO request</Link> — type Job No. <b>{d.job_no}</b> and it appears here.</p>}
          </div>
          <div className="panel"><h2>Messenger runs</h2>
            {d.runs.length === 0 && <p className="muted small">None. Runs linked to one of the truck trips above show here.</p>}
            {d.runs.map((m: any) => <div key={m.id} className="small" style={{ padding: '4px 0' }}>
              <Link href={`/runs/${m.id}`}><b>{m.run_number}</b></Link> <span className="badge outline">{RUN_STATUS[m.status] ?? m.status}</span>
              <div className="muted">{fmtDate(m.required_date)} · {m.documents}</div></div>)}
          </div>
          <div className="panel"><h2>Activity history</h2>
            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…" style={{ flex: 1 }} />
              <button className="btn small" disabled={!note.trim()} onClick={async () => { await act({ action: 'note', body: note }); setNote(''); }}>Add</button></div>
            {[...d.events].reverse().map((e: any) => <div key={e.id} className="small" style={{ padding: '5px 0', borderTop: '1px solid var(--line-soft)' }}>
              <b>{e.title}</b>{e.old_value && e.new_value ? <>: {e.old_value} → {e.new_value}</> : e.new_value ? <>: {e.new_value}</> : null}
              {e.remarks && <div>Remarks: {e.remarks}</div>}
              <div className="muted">{fmtDateTime(e.at)} · {e.user_name}</div></div>)}
          </div>
        </div>
      </div>}
      {!edit && d.status !== 'enquiry' && <><h2 style={{ margin: '18px 0 8px' }}>Commercial record</h2>{commercialPanels}</>}
    </div>
  );
}
