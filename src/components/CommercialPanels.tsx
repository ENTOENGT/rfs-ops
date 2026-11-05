'use client';
/**
 * Commercials sections of the shipment page (Part E): the three numbers and the stage, rates with comparison,
 * quotations, booking, pre-alert and handover. Each section shows only when its step has come, and only its actions
 * the person may use (the server checks again).
 */
import Link from 'next/link';
import { useState } from 'react';
import { api, fmtDate, fmtDateTime, fmtMoney } from './api';
import { useMe } from './Shell';
import { EmailButton } from './EmailButton';
import { NewVendorRequest } from './NewVendorRequest';
import { STAGES, PRE_CONFIRM, PREALERT_CHECKS, divisionName, rateSourceName } from '@/lib/commercialRules';

/** Upload a file to this shipment's documents; returns the new document's id. */
export async function uploadToShipment(fileId: string, file: File, docType: string, description?: string): Promise<string> {
  const mime = file.type || (file.name.toLowerCase().endsWith('.msg') ? 'application/vnd.ms-outlook' : file.name.toLowerCase().endsWith('.eml') ? 'message/rfc822' : '');
  const r = await api(`/api/job-files/${fileId}`, { body: { action: 'upload-url', file_name: file.name, mime_type: mime, size: file.size, doc_type: docType, description } });
  const put = await fetch(r.upload.url, { method: 'PUT', headers: r.upload.headers, body: file });
  if (!put.ok) throw new Error('The upload did not finish. Please try again.');
  const done = await api(`/api/job-files/${fileId}`, { body: { action: 'upload-confirm', ticket: r.ticket } });
  return done.uploaded_document_id;
}

const MAIN = STAGES.filter(([c]) => !['lost', 'cancelled', 'booking_confirmed'].includes(c));
/** The three numbers, the people, and where the shipment stands. */
export function StageHeader({ d }: { d: any }) {
  if (!d.enquiry_ref) return null;
  const idx = MAIN.findIndex(([c]) => c === d.stage);
  return (
    <div className="panel" style={{ padding: '10px 14px' }}>
      <div className="refs">
        <span>Enquiry Ref <b>{d.enquiry_ref}</b></span>
        <span>Shipping Ref <b>{d.shipping_ref ?? '—'}</b></span>
        <span>Job No. <b>{d.job_no ?? 'not yet (from the ERP at handover)'}</b></span>
        <span>Division <b>{divisionName(d.division)}</b></span>
        <span>Salesman <b>{d.salesman_name ?? '—'}</b></span>
        <span>Coordinator <b>{d.coordinator_name ?? '—'}</b></span>
        <span className="muted">Created by {d.created_by_name}</span>
      </div>
      {['lost', 'cancelled'].includes(d.stage) ? <div className="msg warn" style={{ margin: '8px 0 0' }}>{d.stage === 'lost' ? 'Lost' : 'Cancelled'}: {d.cancel_reason}</div>
        : <>
          <div className="stage-track" aria-label="Progress">{MAIN.map(([c, n], i) => <span key={c} className={i < idx ? 'done' : i === idx ? 'now' : ''}>{n}</span>)}</div>
          {d.stage !== 'handed_over' && <p className="small" style={{ margin: '4px 0 0' }}>Next: <b>{d.next_action}</b></p>}
        </>}
    </div>
  );
}

const rateStatus = (s: string) => s === 'requested' ? 'Waiting for rate' : s === 'quoted' ? 'Quoted' : s === 'confirmed' ? 'Chosen' : s === 'cancelled' ? 'Cancelled' : s;
/** Rates from lines, airlines, agents and the Agent Coordinator, compared side by side; and the quotations. */
export function RatesAndQuotes({ d, reload }: { d: any; reload: () => void }) {
  const { me } = useMe();
  const [ask, setAsk] = useState<null | { sameAs?: { id: string; asked: string[] } }>(null);
  const cost = me.financial_access.buyingView;
  if (d.quotations === null && d.vendor_requests === null) return null;
  const rates = (d.vendor_requests ?? []).filter((r: any) => r.service === 'rate');
  const others = (d.vendor_requests ?? []).filter((r: any) => r.service !== 'rate');
  const groups: any[][] = [];
  for (const r of rates) { const g = r.rate_group && groups.find((x) => x[0].rate_group === r.rate_group); if (g) g.push(r); else groups.push([r]); }
  const canAsk = d.can.ask_vendor && PRE_CONFIRM.includes(d.stage ?? 'enquiry');
  return (
    <div className="panel"><h2>Rates and quotation</h2>
      {d.vendor_requests !== null && <>
        <h3 className="small" style={{ margin: '6px 0' }}>Rates received</h3>
        {groups.length === 0 && <p className="muted small">No agent or carrier has been asked for a rate yet.</p>}
        {groups.map((g) => <div key={g[0].rate_group ?? g[0].id} style={{ marginBottom: 12 }}>
          <div className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><span className="muted">{g[0].description.slice(0, 100)}</span><span className="spacer" />
            {canAsk && <button className="linkish" onClick={() => setAsk({ sameAs: { id: g[0].id, asked: g.filter((r) => r.status !== 'cancelled').map((r) => r.vendor_id) } })}>+ Ask more</button>}</div>
          <div className="table-wrap"><table className="t"><thead><tr><th>Request</th><th>Agent / carrier</th><th>Source</th>{cost && <th className="num">Rate</th>}
            <th>Transit</th><th>Free days</th><th>ETD</th><th>Routing</th><th>Valid until</th><th>Status</th>{d.can.ask_vendor && <th />}</tr></thead>
            <tbody>{g.map((r) => <tr key={r.id} className={r.lowest ? 'is-lowest' : ''}>
              <td><Link href={`/vendor-requests/${r.id}`}>{r.request_no}</Link>{r.rate_version > 1 && <div className="muted small">version {r.rate_version}</div>}</td>
              <td>{r.vendor_name}{r.carrier && <div className="muted small">{r.carrier}</div>}{r.lowest && <span className="lowest">Lowest</span>}</td>
              <td className="small">{rateSourceName(r.rate_source)}</td>
              {cost && <td className="num">{r.quoted_cost ? fmtMoney(r.quoted_cost, r.currency) : <span className="muted">waiting</span>}</td>}
              <td>{r.transit_days !== null && r.transit_days !== undefined ? `${r.transit_days} d` : '—'}</td><td>{r.free_days ?? '—'}</td>
              <td>{fmtDate(r.rate_etd)}</td><td className="small">{r.routing ?? '—'}</td><td>{fmtDate(r.rate_valid_until)}</td>
              <td className="small">{rateStatus(r.status)}</td>
              {d.can.ask_vendor && <td style={{ textAlign: 'right' }}>{r.status !== 'cancelled' && <EmailButton kind="vendor_request" id={r.id} className="btn small" label="Email" />}</td>}</tr>)}</tbody></table></div>
        </div>)}
        {others.length > 0 && <p className="small muted">Bookings and other requests: {others.map((r: any, i: number) => <span key={r.id}>{i ? ', ' : ''}<Link href={`/vendor-requests/${r.id}`}>{r.request_no}</Link> ({r.vendor_name}, {r.service})</span>)}</p>}
        {canAsk && <button className="btn small" onClick={() => setAsk({})}>Ask agents / carriers for a rate</button>}
      </>}
      {d.quotations !== null && <>
        <h3 className="small" style={{ margin: '14px 0 6px' }}>Quotations</h3>
        {d.quotations.length === 0 && <p className="muted small">No quotation yet.</p>}
        {d.quotations.map((x: any) => <div key={x.id} className="small" style={{ padding: '3px 0' }}><Link href={`/quotations/${x.id}`}><b>{x.quote_no}</b></Link>
          {x.version_no > 1 && <span className="muted"> v{x.version_no}</span>}{' '}
          <span className="badge" style={{ background: x.status_color }}>{x.status_name}</span> <span className="muted">valid until {fmtDate(x.valid_until)}</span></div>)}
        {d.can.quote && <Link className="btn small primary" style={{ marginTop: 6 }} href={`/quotations/new?job_file=${d.id}`}>Make quotation</Link>}
      </>}
      {ask && <NewVendorRequest jobFileId={d.id} jobNo={d.job_no ?? d.enquiry_ref} sameAs={ask.sameAs}
        description={[d.origin ?? d.port_of_loading, d.destination ?? d.port_of_discharge].filter(Boolean).join(' → ') + (d.cargo_description ? ` — ${d.cargo_description}` : '') + (d.incoterm ? ` (${d.incoterm})` : '')}
        onClose={() => setAsk(null)} onDone={() => { setAsk(null); reload(); }} />}
    </div>
  );
}

/** After the customer confirms: book with the chosen agent / carrier, then record the confirmation. */
export function BookingPanel({ d, act }: { d: any; act: (b: any, done?: string) => Promise<void> }) {
  const { me } = useMe();
  const rates = (d.vendor_requests ?? []).filter((r: any) => r.service === 'rate' && r.status !== 'cancelled' && r.quoted_cost !== null);
  const preferred = rates.find((r: any) => r.status === 'confirmed') ?? rates.find((r: any) => r.lowest) ?? rates[0];
  const [b, setB] = useState<any>({ rate_request_id: preferred?.id ?? '', needed_by: '', description: '' });
  const [c, setC] = useState<any>({ booking_reference: '', carrier: d.carrier ?? '', vessel_flight: d.vessel_flight ?? '', voyage: d.voyage ?? '', etd: d.etd ?? '', eta: d.eta ?? '', prealert_expected: '' });
  if (!d.can.book && !d.can.confirm_booking && !d.booking) return null;
  return (
    <div className="panel"><h2>Booking</h2>
      {d.booking && <p className="small" style={{ marginTop: 0 }}>Booking request <Link href={`/vendor-requests/${d.booking.id}`}><b>{d.booking.request_no}</b></Link> with {d.booking.vendor_name}
        {' '}— {d.booking.status === 'confirmed' ? <>confirmed{d.booking.vendor_reference && <>, ref. <b>{d.booking.vendor_reference}</b></>}</> : d.booking.status}
        {' '}<EmailButton kind="vendor_request" id={d.booking.id} className="btn small" label="Email booking" /></p>}
      {d.can.book && d.stage === 'customer_confirmed' && <>
        {rates.length === 0 && <p className="muted small">No priced rate on this shipment. Ask an agent or carrier first.</p>}
        {rates.length > 0 && <div className="grid g3">
          <label className="f span2"><span>Book with (the rate used)</span><select value={b.rate_request_id} onChange={(e) => setB({ ...b, rate_request_id: e.target.value })}>
            {rates.map((r: any) => <option key={r.id} value={r.id}>{r.vendor_name} — {r.request_no}{me.financial_access.buyingView && r.quoted_cost ? ` — ${fmtMoney(r.quoted_cost, r.currency)}` : ''}{r.lowest ? ' (lowest)' : ''}</option>)}</select></label>
          <label className="f"><span>Confirmation needed by</span><input type="date" value={b.needed_by} onChange={(e) => setB({ ...b, needed_by: e.target.value })} /></label>
          <label className="f span3"><span>Booking instructions (optional)</span><textarea rows={2} value={b.description} onChange={(e) => setB({ ...b, description: e.target.value })}
            placeholder="Shipper, cargo ready date, special handling…" /></label>
        </div>}
        {rates.length > 0 && <button className="btn primary small" onClick={() => act({ action: 'book', ...b }, 'Booking request sent — email it to the agent / carrier')}>Send booking request</button>}
      </>}
      {d.can.confirm_booking && <>
        <h3 className="small" style={{ margin: '12px 0 6px' }}>Booking confirmed by the agent / carrier</h3>
        <div className="grid g3">
          <label className="f"><span>Carrier booking ref. <em>*</em></span><input value={c.booking_reference} onChange={(e) => setC({ ...c, booking_reference: e.target.value })} /></label>
          <label className="f"><span>Line / airline</span><input value={c.carrier} onChange={(e) => setC({ ...c, carrier: e.target.value })} /></label>
          <label className="f"><span>{d.mode === 'air' ? 'Flight' : 'Vessel'}</span><input value={c.vessel_flight} onChange={(e) => setC({ ...c, vessel_flight: e.target.value })} /></label>
          {d.mode !== 'air' && <label className="f"><span>Voyage</span><input value={c.voyage} onChange={(e) => setC({ ...c, voyage: e.target.value })} /></label>}
          <label className="f"><span>ETD</span><input type="date" value={c.etd} onChange={(e) => setC({ ...c, etd: e.target.value })} /></label>
          <label className="f"><span>ETA</span><input type="date" value={c.eta} onChange={(e) => setC({ ...c, eta: e.target.value })} /></label>
          <label className="f"><span>Pre-alert expected on</span><input type="date" value={c.prealert_expected} onChange={(e) => setC({ ...c, prealert_expected: e.target.value })} /></label>
        </div>
        <button className="btn primary small" disabled={!c.booking_reference.trim()} onClick={() => act({ action: 'confirm-booking', ...c }, 'Booking confirmed — now waiting for the pre-alert')}>Save booking confirmation</button>
      </>}
    </div>
  );
}

/** The pre-alert: expected date and follow-up, received (file + details), correction, verified against the booking. */
export function PrealertPanel({ d, act, onError }: { d: any; act: (b: any, done?: string) => Promise<void>; onError: (m: string) => void }) {
  const p = d.prealert;
  const air = d.mode === 'air';
  const [r, setR] = useState<any>({ source: air ? 'airline' : 'shipping_line', vessel_flight: d.vessel_flight ?? '', voyage: d.voyage ?? '', containers: d.containers.map((k: any) => k.container_no).join(', '),
    mbl_mawb: d.mbl_mawb ?? '', hbl_hawb: d.hbl_hawb ?? '', etd: d.etd ?? '', eta: d.eta ?? '' });
  const [file, setFile] = useState<File | null>(null);
  const [checks, setChecks] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState(false);
  if (!p && !d.can.prealert) return null;
  const receive = async () => {
    setBusy(true);
    try {
      const document_id = file ? await uploadToShipment(d.id, file, 'prealert', 'Pre-alert') : undefined;
      await act({ action: 'prealert', step: 'receive', ...r, document_id }, 'Pre-alert recorded — check it against the booking');
      setFile(null);
    } catch (e: any) { onError(e.message); } finally { setBusy(false); }
  };
  const needed = PREALERT_CHECKS.filter(([k]) => !(air && (k === 'check_voyage' || k === 'check_containers')));
  const booked: Record<string, string> = { check_vessel: d.vessel_flight, check_voyage: d.voyage, check_containers: d.containers.map((k: any) => k.container_no).join(', '),
    check_bl: [d.mbl_mawb, d.hbl_hawb].filter(Boolean).join(' / '), check_etd: fmtDate(d.etd), check_eta: fmtDate(d.eta) };
  const said: Record<string, string> = p ? { check_vessel: p.vessel_flight, check_voyage: p.voyage, check_containers: p.containers, check_bl: [p.mbl_mawb, p.hbl_hawb].filter(Boolean).join(' / '),
    check_etd: fmtDate(p.etd), check_eta: fmtDate(p.eta) } : {};
  const status = !p ? 'Awaited' : p.status === 'awaited' ? 'Awaited' : p.status === 'received' ? 'Received — to verify' : p.status === 'correction' ? 'Correction requested' : 'Verified';
  return (
    <div className="panel"><h2>Pre-alert</h2>
      <p className="small" style={{ marginTop: 0 }}>Status: <b>{status}</b>{p?.expected_date && <> · expected {fmtDate(p.expected_date)}</>}{p?.follow_up_date && <> · follow up {fmtDate(p.follow_up_date)}</>}
        {p?.received_at && <> · received {fmtDateTime(p.received_at)}</>}{p?.verified_at && <> · verified by {p.verified_by_name} {fmtDateTime(p.verified_at)}</>}</p>
      {p?.status === 'correction' && <div className="msg warn small">Correction asked: {p.correction_note}</div>}
      {d.can.prealert && p?.status !== 'verified' && <>
        {(!p || ['awaited', 'correction'].includes(p.status)) && <>
          <div className="grid g3">
            <label className="f"><span>From</span><select value={r.source} onChange={(e) => setR({ ...r, source: e.target.value })}>
              <option value="shipping_line">Shipping line</option><option value="airline">Airline</option><option value="agent">Agent</option><option value="other">Other</option></select></label>
            <label className="f span2"><span>Pre-alert file (PDF, email, image)</span><input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
            <label className="f"><span>{air ? 'Flight' : 'Vessel'}</span><input value={r.vessel_flight} onChange={(e) => setR({ ...r, vessel_flight: e.target.value })} /></label>
            {!air && <label className="f"><span>Voyage</span><input value={r.voyage} onChange={(e) => setR({ ...r, voyage: e.target.value })} /></label>}
            {!air && <label className="f"><span>Containers</span><input value={r.containers} onChange={(e) => setR({ ...r, containers: e.target.value.toUpperCase() })} placeholder="MSCU1234565, …" /></label>}
            <label className="f"><span>{air ? 'MAWB' : 'MBL'}</span><input value={r.mbl_mawb} onChange={(e) => setR({ ...r, mbl_mawb: e.target.value })} /></label>
            <label className="f"><span>{air ? 'HAWB' : 'HBL'}</span><input value={r.hbl_hawb} onChange={(e) => setR({ ...r, hbl_hawb: e.target.value })} /></label>
            <label className="f"><span>ETD</span><input type="date" value={r.etd} onChange={(e) => setR({ ...r, etd: e.target.value })} /></label>
            <label className="f"><span>ETA</span><input type="date" value={r.eta} onChange={(e) => setR({ ...r, eta: e.target.value })} /></label>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button className="btn primary small" disabled={busy} onClick={receive}>{busy ? 'Saving…' : p?.status === 'correction' ? 'Corrected pre-alert received' : 'Pre-alert received'}</button>
            <button className="btn small" onClick={() => { const dt = prompt('Expected date (YYYY-MM-DD):', p?.expected_date ?? ''); if (dt !== null) act({ action: 'prealert', step: 'expected', expected_date: dt, follow_up_date: dt }, 'Follow-up saved'); }}>Set expected / follow-up date</button>
          </div>
        </>}
        {p?.status === 'received' && <>
          <p className="small">Tick each line once the pre-alert matches the booking (or the change is accepted).</p>
          <div className="table-wrap"><table className="t"><thead><tr><th>Check</th><th>Booking / shipment</th><th>Pre-alert says</th><th>OK</th></tr></thead>
            <tbody>{needed.map(([k, n]) => <tr key={k} className={booked[k] && said[k] && booked[k] !== said[k] ? 'loss' : ''}><td>{n}</td><td>{booked[k] || '—'}</td><td>{said[k] || '—'}</td>
              <td><input type="checkbox" checked={!!checks[k]} onChange={(e) => setChecks({ ...checks, [k]: e.target.checked })} aria-label={`${n} checked`} /></td></tr>)}</tbody></table></div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
            <button className="btn primary small" disabled={!needed.every(([k]) => checks[k])} onClick={() => act({ action: 'prealert', step: 'verify', ...checks }, 'Pre-alert verified — create the operational job')}>Verified</button>
            <button className="btn small" onClick={() => { const note = prompt('What has to be corrected?'); if (note) act({ action: 'prealert', step: 'correction', note }, 'Correction requested'); }}>Ask for a correction</button>
          </div>
        </>}
      </>}
    </div>
  );
}

/** The operational job: type the Job No. from the ERP; the same record goes to Operations. */
export function HandoverPanel({ d, act }: { d: any; act: (b: any, done?: string) => Promise<void> }) {
  const [h, setH] = useState({ job_no: '', notes: '', skip_prealert_reason: '' });
  if (!d.can.handover) return null;
  const early = d.stage !== 'prealert_verified';
  return (
    <div className="panel warnbox"><h2>Create the operational job</h2>
      <p className="small" style={{ marginTop: 0 }}>Type the Job No. created in the ERP. This same record becomes the operational job and goes to Operations
        (documents, PRO, transport, warehouse, delivery and closing). The Enquiry Ref and Shipping Ref stay linked to it.</p>
      {early && <div className="msg warn small">The pre-alert is not verified yet. As Commercials Manager you can still create the job — say why.</div>}
      <div className="grid g3">
        <label className="f"><span>Job No. (from the ERP) <em>*</em></span><input value={h.job_no} onChange={(e) => setH({ ...h, job_no: e.target.value })} maxLength={40} /></label>
        <label className="f span2"><span>Handover notes for Operations</span><input value={h.notes} onChange={(e) => setH({ ...h, notes: e.target.value })} /></label>
        {early && <label className="f span3"><span>Why before the pre-alert? <em>*</em></span><input value={h.skip_prealert_reason} onChange={(e) => setH({ ...h, skip_prealert_reason: e.target.value })} /></label>}
      </div>
      <button className="btn primary small" disabled={!h.job_no.trim()} onClick={() => confirm(`Create Job No. ${h.job_no.trim()} and hand over to Operations?`)
        && act({ action: 'handover', ...h }, `Job No. ${h.job_no.trim()} created — handed over to Operations`)}>Create job and hand over</button>
    </div>
  );
}
