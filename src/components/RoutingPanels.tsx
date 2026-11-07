'use client';
import { useState } from 'react';
import { fmtDate, fmtDateTime } from '@/components/api';
import { useMe } from '@/components/Shell';
import { EmailButton } from '@/components/EmailButton';
import { uploadToShipment } from '@/components/CommercialPanels';
import { PRE_CONFIRM } from '@/lib/commercialRules';
import { BL_WITH_CUSTOMER, blStatusColor, blStatusName, routeLabel, vesselStatusName } from '@/lib/routingRules';

type Act = (b: any, done?: string) => Promise<unknown>;
const blank = { origin_country: '', origin_city: '', pol: '', destination_city: '', pod: '', final_delivery: '', mode: '', cargo_description: '', notes: '' };

/** Part G2: several loading ports (or destinations) under one Enquiry Ref. Changes stop once the customer confirms. */
export function RoutesPanel({ d, act }: { d: any; act: Act }) {
  const [f, setF] = useState<any>(null);
  const routes: any[] = d.routes ?? [];
  const open = d.can.edit && PRE_CONFIRM.includes(d.stage ?? '');
  if (!d.enquiry_ref || (!routes.length && !open)) return null;
  const save = async () => {
    const ok = await act(f.id ? { action: 'route', step: 'update', route_id: f.id, ...f } : { action: 'route', step: 'add', ...f }, f.id ? 'Option changed.' : 'Option added.');
    if (ok) setF(null);
  };
  const remove = (r: any) => { const why = prompt(`Why remove option ${r.option_no}?`); if (why) act({ action: 'route', step: 'remove', route_id: r.id, reason: why }, 'Option removed.'); };
  const field = (k: string, label: string, w = '') => <label className={`f ${w}`}><span>{label}</span><input value={f[k] ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} /></label>;
  return (
    <div className="panel"><h2>Route options</h2>
      {routes.length === 0 ? <p className="muted small" style={{ marginTop: 0 }}>One route: {[d.port_of_loading ?? d.origin, d.port_of_discharge ?? d.destination].filter(Boolean).join(' → ') || '—'}.
        If the customer wants prices from other loading ports too, add them as options — they stay under {d.enquiry_ref}.</p>
        : <div className="table-wrap"><table className="t"><thead><tr><th>Option</th><th>Origin</th><th>Loading port</th><th>Discharge port</th><th>Destination / delivery</th><th className="num">Rate requests</th><th /></tr></thead>
          <tbody>{routes.map((r) => <tr key={r.id} className={d.selected_route_id && d.selected_route_id !== r.id ? 'muted' : ''}>
            <td><b>Option {r.option_no}</b>{d.selected_route_id === r.id && <div><span className="badge" style={{ background: '#22543D' }}>Chosen by customer</span></div>}</td>
            <td>{[r.origin_city, r.origin_country].filter(Boolean).join(', ') || '—'}</td><td>{r.pol ?? '—'}</td><td>{r.pod ?? '—'}</td>
            <td>{[r.destination_city, r.final_delivery].filter(Boolean).join(' · ') || '—'}</td><td className="num">{r.rate_requests}</td>
            <td style={{ whiteSpace: 'nowrap' }}>{open && <><button className="btn small" onClick={() => setF({ ...blank, ...r })}>Change</button>
              {routes.length > 1 && <button className="btn small" onClick={() => remove(r)}>Remove</button>}</>}</td></tr>)}</tbody></table></div>}
      {open && !f && <button className="btn small" style={{ marginTop: 8 }} onClick={() => setF({ ...blank })}>+ Add a loading port option</button>}
      {f && <div style={{ marginTop: 10 }}><div className="grid g4">
        {field('origin_city', 'Origin city')}{field('origin_country', 'Origin country')}{field('pol', 'Loading port (POL) *')}{field('pod', 'Discharge port (POD)')}
        {field('destination_city', 'Destination city')}{field('final_delivery', 'Final delivery place')}
        <label className="f"><span>Mode</span><select value={f.mode ?? ''} onChange={(e) => setF({ ...f, mode: e.target.value })}><option value="">Same as the enquiry</option>
          <option value="sea_fcl">Sea FCL</option><option value="sea_lcl">Sea LCL</option><option value="air">Air</option><option value="road">Road</option></select></label>
        {field('cargo_description', 'Cargo (if different)')}
      </div>{!f.id && <p className="muted small">The destination is the enquiry's own unless you type another.</p>}
        <div className="form-actions"><button className="btn" onClick={() => setF(null)}>Cancel</button><button className="btn primary" onClick={save}>{f.id ? 'Save option' : 'Add option'}</button></div></div>}
    </div>
  );
}

/** Part G2: Direct or Via, one line per vessel leg; Pending → Received → Verified. */
export function VesselPanel({ d, act }: { d: any; act: Act }) {
  const legs0 = (d.legs ?? []).map((l: any) => ({ ...l, etd: l.etd?.slice?.(0, 10) ?? '', eta: l.eta?.slice?.(0, 10) ?? '' }));
  const [f, setF] = useState<any>(null);
  const after = !PRE_CONFIRM.includes(d.stage ?? 'enquiry') && d.stage !== 'lost' && d.stage !== 'cancelled';
  if (!d.enquiry_ref || !after || d.mode === 'road') return null;
  const start = () => {
    const legs = legs0.length ? [...legs0] : [{ vessel: d.vessel_flight ?? '', voyage: d.voyage ?? '', from_port: d.port_of_loading ?? '', to_port: d.port_of_discharge ?? '', etd: '', eta: '' }];
    // a via shipment always shows a line for the connecting vessel
    if (d.routing_type === 'via' && legs.length < 2) legs.push({ vessel: '', voyage: '', from_port: legs[0].to_port ?? '', to_port: d.port_of_discharge ?? '', etd: '', eta: '' });
    setF({ routing_type: d.routing_type ?? 'direct', note: '', legs });
  };
  const setLeg = (i: number, k: string, v: string) => setF({ ...f, legs: f.legs.map((l: any, j: number) => j === i ? { ...l, [k]: v } : l) });
  return (
    <div className="panel"><h2>Vessel details</h2>
      <p className="small" style={{ marginTop: 0 }}><span className="badge" style={{ background: d.vessel_status === 'verified' ? '#22543D' : d.vessel_status === 'received' ? '#2B6CB0' : '#8A94A6' }}>{vesselStatusName(d.vessel_status)}</span>
        {d.routing_type && <> · <b>{d.routing_type === 'via' ? 'Via / transshipment' : 'Direct'}</b></>}{d.booking_reference && <> · booking <b>{d.booking_reference}</b></>}
        {d.booked_equipment && <> · {d.booked_equipment}</>}</p>
      {!f && legs0.length > 0 && <div className="table-wrap"><table className="t"><thead><tr><th>Leg</th><th>Vessel / voyage</th><th>From → to</th><th>ETD</th><th>ETA</th></tr></thead>
        <tbody>{legs0.map((l: any) => <tr key={l.leg_no}><td>{l.leg_no}</td><td><b>{l.vessel}</b> {l.voyage}</td><td>{l.from_port ?? '—'} → {l.to_port ?? '—'}</td><td>{fmtDate(l.etd)}</td><td>{fmtDate(l.eta)}</td></tr>)}</tbody></table></div>}
      {!f && legs0.length === 0 && <p className="muted small">No vessel yet. They come with the booking confirmation.</p>}
      {!f && d.can.edit && <div style={{ display: 'flex', gap: 6, marginTop: 8 }}>
        <button className="btn small" onClick={start}>{legs0.length ? 'Change vessel details' : 'Enter vessel details'}</button>
        {d.vessel_status === 'received' && <button className="btn small primary" onClick={() => act({ action: 'vessel', step: 'verify' }, 'Vessel details verified.')}>Verified</button>}
        {d.booking && <EmailButton kind="vendor_request" id={d.booking.id} className="btn small" label="Ask carrier for vessel details" update="vessel_details_request" />}</div>}
      {f && <div>
        <label className="f" style={{ maxWidth: 260 }}><span>Direct or via</span><select value={f.routing_type} onChange={(e) => setF({ ...f, routing_type: e.target.value,
          legs: e.target.value === 'via' && f.legs.length < 2 ? [...f.legs, { vessel: '', voyage: '', from_port: '', to_port: d.port_of_discharge ?? '', etd: '', eta: '' }] : e.target.value === 'direct' ? f.legs.slice(0, 1) : f.legs })}>
          <option value="direct">Direct</option><option value="via">Via / transshipment</option></select></label>
        {f.legs.map((l: any, i: number) => <div key={i} className="grid g6" style={{ alignItems: 'end' }}>
          <label className="f"><span>Leg {i + 1} vessel *</span><input value={l.vessel ?? ''} onChange={(e) => setLeg(i, 'vessel', e.target.value)} /></label>
          <label className="f"><span>Voyage</span><input value={l.voyage ?? ''} onChange={(e) => setLeg(i, 'voyage', e.target.value)} /></label>
          <label className="f"><span>From port</span><input value={l.from_port ?? ''} onChange={(e) => setLeg(i, 'from_port', e.target.value)} /></label>
          <label className="f"><span>To port{f.routing_type === 'via' && i < f.legs.length - 1 ? ' (transshipment)' : ''}</span><input value={l.to_port ?? ''} onChange={(e) => setLeg(i, 'to_port', e.target.value)} /></label>
          <label className="f"><span>ETD</span><input type="date" value={l.etd ?? ''} onChange={(e) => setLeg(i, 'etd', e.target.value)} /></label>
          <label className="f"><span>ETA</span><input type="date" value={l.eta ?? ''} onChange={(e) => setLeg(i, 'eta', e.target.value)} /></label>
        </div>)}
        {f.routing_type === 'via' && <div style={{ display: 'flex', gap: 6 }}><button className="btn small" onClick={() => setF({ ...f, legs: [...f.legs, { vessel: '', voyage: '', from_port: f.legs.at(-1)?.to_port ?? '', to_port: '', etd: '', eta: '' }] })}>+ Add leg</button>
          {f.legs.length > 2 && <button className="btn small" onClick={() => setF({ ...f, legs: f.legs.slice(0, -1) })}>Remove last leg</button>}</div>}
        <label className="f"><span>Note (e.g. why it changed)</span><input value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
        <div className="form-actions"><button className="btn" onClick={() => setF(null)}>Cancel</button>
          <button className="btn primary" onClick={async () => { if (await act({ action: 'vessel', step: 'save', ...f }, 'Vessel details saved — the Salesman and Coordinator were told.')) setF(null); }}>Save vessel details</button></div>
      </div>}
    </div>
  );
}

/** Part G2: BL drafts with versions, the correction loop with the customer, confirmation, and the final BL on its own. */
export function BlPanel({ d, act }: { d: any; act: Act }) {
  const { can } = useMe();
  const [file, setFile] = useState<File | null>(null);
  const [blNo, setBlNo] = useState('');
  const [txt, setTxt] = useState('');
  const [busy, setBusy] = useState(false);
  const after = !PRE_CONFIRM.includes(d.stage ?? 'enquiry') && !['lost', 'cancelled'].includes(d.stage);
  if (!d.enquiry_ref || !after || d.mode === 'road') return null;
  const drafts: any[] = d.bl_drafts ?? [];
  const cur = drafts[0];
  const st = d.bl_status;
  const withCustomer = BL_WITH_CUSTOMER.includes(st);
  const up = async (docType: string, label: string, body: (id: string) => any, done: string) => {
    if (!file) return;
    setBusy(true);
    try { const id = await uploadToShipment(d.id, file, docType, label); if (await act(body(id), done)) { setFile(null); setBlNo(''); setTxt(''); } }
    catch (e: any) { alert(e.message); } finally { setBusy(false); }
  };
  const fileBox = (label: string) => <label className="f"><span>{label}</span><input type="file" accept=".pdf,.jpg,.png,.msg,.eml" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>;
  const amend = st === 'customer_confirmed' && can('commercial.manage');
  return (
    <div className="panel"><h2>BL draft</h2>
      <p className="small" style={{ marginTop: 0 }}><span className="badge" style={{ background: blStatusColor(st) }}>{blStatusName(st)}</span>
        {withCustomer && <> · <b>Customer confirmation pending</b></>}{cur?.bl_no && <> · BL no. <b>{cur.bl_no}</b></>}
        {d.final_bl_no ? <> · <span className="badge" style={{ background: '#22543D' }}>Final BL received</span> {d.final_bl_no} ({fmtDateTime(d.final_bl_received_at)})</> : st === 'customer_confirmed' && <> · <span className="muted">final BL not received yet</span></>}</p>
      {drafts.length > 0 && <div className="table-wrap"><table className="t"><thead><tr><th>Version</th><th>Received</th><th>Sent to customer</th><th>Customer reply</th><th>Correction to agent</th></tr></thead>
        <tbody>{drafts.map((b) => <tr key={b.id}><td><a href={`/api/jf-files/${b.document_id}`} target="_blank" rel="noreferrer"><b>v{b.version}</b> {b.file_name}</a>
            {b.amendment_reason && <div className="flag">Amendment: {b.amendment_reason}</div>}</td>
          <td className="small">{fmtDateTime(b.received_at)}<div className="muted">{b.received_by_name}</div></td>
          <td className="small">{b.sent_at ? <>{fmtDateTime(b.sent_at)}<div className="muted">{b.sent_to}</div></> : '—'}</td>
          <td className="small">{b.customer_reply === 'confirmed' ? <><b style={{ color: '#22543D' }}>Confirmed</b> {fmtDateTime(b.customer_reply_at)}<div className="muted">{b.confirmation_evidence}</div></>
            : b.customer_reply === 'correction' ? <><b style={{ color: '#C53030' }}>Corrections</b><div>{b.correction_notes}</div></> : '—'}</td>
          <td className="small">{b.correction_sent_at ? <>{fmtDateTime(b.correction_sent_at)}<div className="muted">{b.correction_sent_to}</div></> : '—'}</td></tr>)}</tbody></table></div>}
      {d.can.edit && <div style={{ marginTop: 10 }}>
        {(st === 'awaiting' || ['correction_required', 'correction_sent'].includes(st) || amend) && <div className="grid g4" style={{ alignItems: 'end' }}>
          {fileBox(st === 'awaiting' ? 'BL draft from the agent / line' : 'Revised BL draft')}
          {st === 'awaiting' && <label className="f"><span>BL no.</span><input value={blNo} onChange={(e) => setBlNo(e.target.value)} /></label>}
          {amend && <label className="f span2"><span>Customer already confirmed — why amend? *</span><input value={txt} onChange={(e) => setTxt(e.target.value)} /></label>}
          <div><button className="btn small primary" disabled={!file || busy || (amend && !txt.trim())} onClick={() => up('bl_draft', 'BL draft',
            (id) => ({ action: 'bl', step: 'receive', document_id: id, bl_no: blNo || undefined, amendment_reason: amend ? txt : undefined }), 'BL draft saved as a new version.')}>
            {busy ? 'Uploading…' : 'Save BL draft'}</button></div></div>}
        {['received', 'revised_received'].includes(st) && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'end' }}>
          {st === 'received' && <button className="btn small" onClick={() => act({ action: 'bl', step: 'review' }, 'Marked under review.')}>Checking it</button>}
          <EmailButton kind="job_file" id={d.id} className="btn small" label="Email draft to customer" update={cur?.version > 1 ? 'bl_revised_to_customer' : 'bl_draft_to_customer'} />
          <button className="btn small primary" onClick={() => { const to = prompt('Sent to (customer name / email)'); if (to) act({ action: 'bl', step: 'send', sent_to: to }, 'Recorded as sent to the customer.'); }}>Sent to customer</button></div>}
        {st === 'under_review' && <div style={{ display: 'flex', gap: 6 }}>
          <EmailButton kind="job_file" id={d.id} className="btn small" label="Email draft to customer" update="bl_draft_to_customer" />
          <button className="btn small primary" onClick={() => { const to = prompt('Sent to (customer name / email)'); if (to) act({ action: 'bl', step: 'send', sent_to: to }, 'Recorded as sent to the customer.'); }}>Sent to customer</button></div>}
        {withCustomer && <div className="grid g3" style={{ alignItems: 'end' }}>
          <label className="f span2"><span>Customer's answer (corrections, or how they confirmed)</span><textarea rows={2} value={txt} onChange={(e) => setTxt(e.target.value)} /></label>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button className="btn small" disabled={!txt.trim()} onClick={async () => { if (await act({ action: 'bl', step: 'correction', correction_notes: txt }, 'Correction recorded — the group was told.')) setTxt(''); }}>Corrections asked</button>
            <button className="btn small primary" disabled={txt.trim().length < 10} onClick={async () => { if (await act({ action: 'bl', step: 'confirm', evidence_note: txt }, 'BL draft confirmed by the customer — locked.')) setTxt(''); }}>Customer confirmed</button></div></div>}
        {st === 'correction_required' && <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          {d.booking && <EmailButton kind="vendor_request" id={d.booking.id} className="btn small" label="Email corrections to agent / line" update="bl_correction_request" />}
          <button className="btn small primary" onClick={() => { const to = prompt('Sent to (agent / line)'); if (to) act({ action: 'bl', step: 'correction_sent', sent_to: to }, 'Recorded as sent to the agent / line.'); }}>Corrections sent</button></div>}
        {st === 'customer_confirmed' && !d.final_bl_no && <div className="grid g4" style={{ alignItems: 'end', marginTop: 8 }}>
          <label className="f"><span>Final BL no. *</span><input value={blNo} onChange={(e) => setBlNo(e.target.value)} /></label>{fileBox('Final BL (file)')}
          <div style={{ display: 'flex', gap: 6 }}><button className="btn small primary" disabled={!blNo.trim() || busy} onClick={() => file
            ? up('bill_of_lading', 'Final BL', (id) => ({ action: 'bl', step: 'final', bl_no: blNo, document_id: id }), 'Final BL recorded.')
            : act({ action: 'bl', step: 'final', bl_no: blNo }, 'Final BL recorded.')}>Final BL received</button>
            <EmailButton kind="job_file" id={d.id} className="btn small" label="Email confirmation" update="bl_final_confirmation" /></div></div>}
      </div>}
    </div>
  );
}
