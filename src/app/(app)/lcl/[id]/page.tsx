'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime } from '@/components/api';
import { useMe } from '@/components/Shell';
import { LclHeadForm } from '@/components/LclHeadForm';
import { OWNER_TYPES, LCL_DOC_TYPES, CONDITIONS, receivingColor, receivingName } from '@/lib/lclRules';

const TABS: [string, string][] = [['overview', 'Overview'], ['shipments', 'House shipments'], ['receiving', 'Cargo receiving'], ['container', 'Container details'],
  ['mbl', 'Master BL'], ['documents', 'Documents'], ['stuffing', 'Stuffing and dispatch'], ['milestones', 'Milestones'], ['history', 'Activity history']];
const blankShp = { owner_type: 'partner_agent', packages: '', gross_weight_kg: '', volume_cbm: '' };

export default function Consolidation({ params }: { params: { id: string } }) {
  const { lk, me } = useMe();
  const seeFiles = me.permissions.some((p) => p.startsWith('jobfiles.'));   // the LCL Team sees the reference, not the shipment page
  const [d, setD] = useState<any>(null);
  const [tab, setTab] = useState('overview');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [edit, setEdit] = useState<any>(null);
  const [add, setAdd] = useState<any>(null);
  const [cands, setCands] = useState<any[] | null>(null);
  const [rcv, setRcv] = useState<any>(null);
  const [upl, setUpl] = useState<any>({ doc_type: 'mbl_draft' });
  const [busy, setBusy] = useState(false);
  const load = () => api(`/api/lcl/${params.id}`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [params.id]);  // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (body: any, done = 'Saved.') => {
    setErr(''); setOk('');
    try { setD(await api(`/api/lcl/${params.id}`, { body })); setOk(done); return true; } catch (e: any) { setErr(e.message); window.scrollTo(0, 0); return false; }
  };
  const ask = (body: any, question: string, done: string, key = 'reason') => { const v = prompt(question); if (v) act({ ...body, [key]: v }, done); };
  if (!d) return <div className="page">{err ? <div className="msg err">{err}</div> : <p className="muted">Loading…</p>}</div>;
  const n = (v: any, dp = 2) => Number(v).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const ref = (s: any) => s.job_file_id ? (seeFiles ? <Link href={`/job-files/${s.job_file_id}`}>{s.job_no ?? s.shipping_ref ?? s.enquiry_ref}</Link> : <span>{s.job_no ?? s.shipping_ref ?? s.enquiry_ref}</span>) : null;
  const owner = (s: any) => s.customer_name ?? s.partner_name ?? s.shipper;
  const upload = async () => {
    if (!upl.file) return;
    setBusy(true); setErr('');
    try {
      const file: File = upl.file;
      const mime = file.type || (file.name.endsWith('.msg') ? 'application/vnd.ms-outlook' : file.name.endsWith('.eml') ? 'message/rfc822' : '');
      const r = await api(`/api/lcl/${params.id}`, { body: { action: 'upload-url', file_name: file.name, mime_type: mime, size: file.size, doc_type: upl.doc_type,
        shipment_id: upl.shipment_id || undefined, replaces_id: upl.replaces_id || undefined, description: upl.description } });
      const put = await fetch(r.upload.url, { method: 'PUT', headers: r.upload.headers, body: file });
      if (!put.ok) throw new Error('The upload did not finish. Please try again.');
      setD(await api(`/api/lcl/${params.id}`, { body: { action: 'upload-confirm', ticket: r.ticket } }));
      setUpl({ doc_type: upl.doc_type }); setOk('Document uploaded.');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  const openDoc = async (id: string) => { try { window.open((await api(`/api/lcl/${params.id}/documents/${id}`)).url, '_blank'); } catch (e: any) { setErr(e.message); } };
  const bar = (pct: number | null) => pct === null ? '—' : <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
    <span style={{ width: 120, height: 8, background: '#EEF0F3', borderRadius: 4, overflow: 'hidden', display: 'inline-block' }}>
      <span style={{ display: 'block', height: '100%', width: `${Math.min(100, pct)}%`, background: pct > 100 ? '#C53030' : '#2C7A7B' }} /></span>{pct}%</span>;
  const shipTable = (extra: (s: any) => JSX.Element | null, cols: string[] = []) => (
    <div className="table-wrap"><table className="t"><thead><tr><th>HBL</th><th>Cargo owner</th><th>Shipper → Consignee</th><th>Shipment</th>
      <th className="num">Pkgs</th><th className="num">Kg</th><th className="num">CBM</th>{cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
      <tbody>{d.shipments.map((s: any) => <tr key={s.id}>
        <td><b>{s.hbl_no ?? <span className="muted">—</span>}</b></td>
        <td>{owner(s)}<div className="muted small">{OWNER_TYPES.find(([k]) => k === s.owner_type)?.[1]}{s.salesman_name && ` · ${s.salesman_name}`}</div></td>
        <td className="small">{s.shipper ?? '—'} → {s.consignee ?? '—'}{s.special_handling && <div className="flag">{s.special_handling}</div>}</td>
        <td>{ref(s) ?? '—'}</td><td className="num">{s.packages}</td><td className="num">{n(s.gross_weight_kg)}</td><td className="num">{n(s.volume_cbm, 3)}</td>
        {extra(s)}</tr>)}
        {d.shipments.length === 0 && <tr><td colSpan={7 + cols.length} className="muted">No house shipments yet.</td></tr>}</tbody></table></div>);
  const pendingDocs = (s: any) => s.hbl_no && !d.documents.some((x: any) => x.shipment_id === s.id && x.doc_type === 'hbl_final' && !x.replaced_at);
  return (
    <div className="page">
      <div className="page-head"><h1>{d.con_ref}</h1><span className="badge" style={{ background: d.status_color }}>{d.status_name}</span><span className="spacer" />
        {d.can.ready && <button className="btn primary" onClick={() => act({ action: 'ready' }, 'Ready for stuffing.')}>Ready for stuffing</button>}
        {d.can.reopen && <button className="btn" onClick={() => act({ action: 'reopen' }, 'Reopened.')}>Reopen for more cargo</button>}
        {d.can.departed && <button className="btn primary" onClick={() => ask({ action: 'departed' }, 'Departure date (YYYY-MM-DD), empty = today', 'Departure recorded.', 'date')}>Departed</button>}
        {d.can.arrived && <button className="btn primary" onClick={() => ask({ action: 'arrived' }, 'Arrival date (YYYY-MM-DD)', 'Arrival recorded.', 'date')}>Arrived</button>}
        {d.can.close && <button className="btn" onClick={() => confirm('Close this consolidation?') && act({ action: 'close' }, 'Closed.')}>Close</button>}
        {d.can.cancel && <button className="btn danger" onClick={() => ask({ action: 'cancel' }, 'Why is it cancelled? (all house shipments are released)', 'Cancelled.')}>Cancel</button>}
      </div>
      {d.status === 'cancelled' && <div className="msg warn">Cancelled: {d.cancel_reason}</div>}
      {err && <div className="msg err">{err}</div>}{ok && <div className="msg ok">{ok}</div>}
      <div className="refs panel" style={{ padding: '10px 14px' }}>
        <span>Route <b>{[d.pol ?? d.origin, d.pod ?? d.destination].filter(Boolean).join(' → ')}</b></span><span>Carrier <b>{d.carrier ?? '—'}</b></span>
        <span>Booking <b>{d.carrier_booking_id ?? '—'}</b></span><span>Container <b>{d.container_no ?? '—'}</b></span><span>MBL <b>{d.mbl_no ?? '—'}</b></span>
        <span>HBLs <b>{d.total_hbls}</b></span><span>CBM <b>{n(d.totals.cbm, 2)}</b></span><span>Used {bar(d.utilisation_pct)}</span><span>ETD <b>{fmtDate(d.etd)}</b></span>
      </div>
      <div className="tabs link-tabs" role="tablist" style={{ margin: '12px 0', flexWrap: 'wrap' }}>
        {TABS.map(([k, t]) => <a key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} href={`#${k}`} onClick={(e) => { e.preventDefault(); setTab(k); }}>{t}</a>)}
      </div>

      {tab === 'overview' && (edit ? <>
        <LclHeadForm f={edit} setF={setEdit} types={d.container_types} warehouses={d.warehouses} vendors={lk.vendors ?? []} />
        {['stuffed', 'sealed', 'dispatched', 'departed', 'arrived'].includes(d.status) && <label className="f"><span>Reason for the change</span><input value={edit.reason ?? ''} onChange={(e) => setEdit({ ...edit, reason: e.target.value })} /></label>}
        <div className="form-actions"><button className="btn" onClick={() => setEdit(null)}>Cancel</button>
          <button className="btn primary" onClick={async () => { setErr(''); try { setD(await api(`/api/lcl/${params.id}`, { method: 'PATCH', body: edit })); setEdit(null); setOk('Saved.'); } catch (e: any) { setErr(e.message); } }}>Save</button></div>
      </> : <div className="cols">
        <div className="panel"><h2>Consolidation</h2><dl className="kv">
          <dt>Division</dt><dd>{d.division_name}</dd><dt>Direction</dt><dd>{d.direction}</dd>
          <dt>Origin → destination</dt><dd>{[d.origin, d.destination].filter(Boolean).join(' → ') || '—'}</dd><dt>POL → POD</dt><dd>{[d.pol, d.pod].filter(Boolean).join(' → ') || '—'}</dd>
          <dt>Shipping line</dt><dd>{d.carrier ?? '—'}{d.carrier_vendor_name && <div className="muted small">{d.carrier_vendor_name}</div>}</dd>
          <dt>Carrier booking ID</dt><dd>{d.carrier_booking_id ?? '—'}{d.booking_confirmed_at ? <div className="muted small">confirmed {fmtDateTime(d.booking_confirmed_at)}</div>
            : d.can.booking && <div><button className="linkish" onClick={() => ask({ action: 'booking_confirmed' }, 'Carrier booking ID', 'Booking confirmed.', 'carrier_booking_id')}>Booking confirmed</button></div>}</dd>
          <dt>Warehouse</dt><dd>{d.warehouse_name ?? '—'}</dd><dt>Remarks</dt><dd>{d.remarks ?? '—'}</dd>
          <dt>Created</dt><dd>{fmtDateTime(d.created_at)} by {d.created_by_name}</dd></dl>
          {d.can.edit && <button className="btn small" style={{ marginTop: 8 }} onClick={() => setEdit({ ...d, etd: d.etd ?? '', eta: d.eta ?? '' })}>Edit details</button>}</div>
        <div className="panel"><h2>Totals</h2><dl className="kv">
          <dt>House shipments</dt><dd>{d.total_hbls}</dd><dt>Packages</dt><dd>{d.totals.packages} declared · {d.totals.received_packages} received</dd>
          <dt>Gross weight</dt><dd>{n(d.totals.weight_kg)} kg declared · {n(d.totals.received_weight_kg)} kg received</dd>
          <dt>Volume</dt><dd>{n(d.totals.cbm, 3)} CBM declared · {n(d.totals.received_cbm, 3)} CBM received</dd>
          <dt>Container used</dt><dd>{bar(d.utilisation_pct)}{d.capacity_cbm && <span className="muted small"> of {Number(d.capacity_cbm)} CBM</span>}</dd>
          <dt>Payload used</dt><dd>{bar(d.totals.payload_pct)}</dd>
          <dt>Cargo receiving</dt><dd>{d.receiving_summary}</dd><dt>Stuffing</dt><dd>{d.stuffing_summary}</dd></dl></div>
      </div>)}

      {tab === 'shipments' && <div className="panel"><h2>House shipments</h2>
        {shipTable((s) => <>
          <td><span className="badge" style={{ background: receivingColor(s.receiving_status) }}>{receivingName(s.receiving_status)}</span></td>
          <td className="small">{s.stuffing_status === 'shut_out' ? 'Shut out' : s.stuffing_status === 'stuffed' ? 'Stuffed' : '—'}</td>
          <td style={{ whiteSpace: 'nowrap' }}>{d.can.edit && <button className="btn small" onClick={() => { const h = prompt('House BL number', s.hbl_no ?? ''); if (h !== null) act({ action: 'update_shipment', shipment_id: s.id, hbl_no: h }, 'HBL saved.'); }}>HBL</button>}
            {d.can.remove && s.stuffing_status !== 'stuffed' && <button className="btn small danger" onClick={() => ask({ action: 'remove_shipment', shipment_id: s.id }, 'Why is it removed from this container?', 'Removed.')}>Remove</button>}</td>
        </>, ['Receiving', 'Stuffing', ''])}
        {d.removed.length > 0 && <p className="muted small">Removed: {d.removed.map((r: any) => `${r.hbl_no ?? r.shipper ?? ''} (${r.removed_reason})`).join('; ')}</p>}
        {d.can.add && !add && <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          <button className="btn small primary" onClick={() => { setAdd({ mode: 'file' }); api('/api/lcl/candidates').then(setCands).catch((e) => setErr(e.message)); }}>Add own customer's shipment</button>
          <button className="btn small" onClick={() => setAdd({ mode: 'manual', ...blankShp })}>Add partner agent / other cargo</button></div>}
        {add?.mode === 'file' && <div className="panel" style={{ marginTop: 10 }}><h3 className="small">Confirmed Sea LCL shipments not in a container yet</h3>
          <input placeholder="Search Job No., Shipping Ref, customer…" onChange={(e) => api(`/api/lcl/candidates?q=${encodeURIComponent(e.target.value)}`).then(setCands)} />
          <div className="table-wrap"><table className="t"><tbody>{cands?.map((c) => <tr key={c.id}><td><b>{c.job_no ?? c.shipping_ref ?? c.enquiry_ref}</b></td><td>{c.customer_name}</td>
            <td className="small">{[c.port_of_loading ?? c.origin, c.port_of_discharge ?? c.destination].filter(Boolean).join(' → ')}</td>
            <td className="small">{c.packages ?? '?'} pkgs · {c.volume_cbm ?? '?'} CBM</td>
            <td><button className="btn small primary" onClick={async () => { if (await act({ action: 'add_shipment', job_file_id: c.id }, 'House shipment added.')) setAdd(null); }}>Add</button></td></tr>)}
            {cands?.length === 0 && <tr><td className="muted">None found. The shipment must be Sea LCL and confirmed by the customer.</td></tr>}</tbody></table></div>
          <button className="btn small" onClick={() => setAdd(null)}>Close</button></div>}
        {add?.mode === 'manual' && <div className="panel" style={{ marginTop: 10 }}><h3 className="small">Partner agent or other cargo</h3><div className="grid g4">
          <label className="f"><span>Cargo owner type</span><select value={add.owner_type} onChange={(e) => setAdd({ ...add, owner_type: e.target.value })}>
            {OWNER_TYPES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          {add.owner_type === 'partner_agent' && <label className="f"><span>Partner agent *</span><select value={add.partner_vendor_id ?? ''} onChange={(e) => setAdd({ ...add, partner_vendor_id: e.target.value })}>
            <option value="">Choose</option>{(lk.vendors ?? []).map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>}
          {add.owner_type === 'own_customer' && <label className="f"><span>Customer *</span><select value={add.customer_id ?? ''} onChange={(e) => setAdd({ ...add, customer_id: e.target.value })}>
            <option value="">Choose</option>{lk.customers.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>}
          {[['hbl_no', 'House BL no.'], ['shipper', 'Shipper *'], ['consignee', 'Consignee *'], ['cargo_description', 'Cargo *'], ['packages', 'Packages *'], ['gross_weight_kg', 'Gross weight kg *'],
            ['volume_cbm', 'CBM *'], ['dimensions', 'Dimensions'], ['marks', 'Marks and numbers'], ['special_handling', 'Special handling']].map(([k, l]) =>
            <label key={k} className="f"><span>{l}</span><input value={add[k] ?? ''} onChange={(e) => setAdd({ ...add, [k]: e.target.value })} /></label>)}
          <label className="f"><span>Cargo expected on</span><input type="date" value={add.expected_arrival ?? ''} onChange={(e) => setAdd({ ...add, expected_arrival: e.target.value })} /></label>
        </div><div className="form-actions"><button className="btn" onClick={() => setAdd(null)}>Cancel</button>
          <button className="btn primary" onClick={async () => { const { mode, ...b } = add; if (await act({ action: 'add_shipment', ...b }, 'House shipment added.')) setAdd(null); }}>Add house shipment</button></div></div>}
      </div>}

      {tab === 'receiving' && <div className="panel"><h2>Cargo receiving</h2>
        <p className="muted small" style={{ marginTop: 0 }}>Record each arrival. Declared figures stay as they are; a part delivery stays "Partly received"; damage, shortage or a difference over 5% shows as "Received with differences".</p>
        {shipTable((s) => <>
          <td className="num">{s.received_packages}</td><td className="num">{n(s.received_weight_kg)}</td><td className="num">{n(s.received_cbm, 3)}</td>
          <td><span className="badge" style={{ background: receivingColor(s.receiving_status) }}>{receivingName(s.receiving_status)}</span>
            {s.cargo_verified_at && <div className="muted small">verified by {s.verified_by_name}</div>}</td>
          <td style={{ whiteSpace: 'nowrap' }}>{d.can.receive && s.stuffing_status === 'pending' && !s.cargo_verified_at && s.receiving_status !== 'received' && <button className="btn small primary" onClick={() => setRcv({ shipment_id: s.id, label: s.hbl_no ?? owner(s),
              packages: Math.max(0, s.packages - s.received_packages), weight_kg: Math.max(0, Number(s.gross_weight_kg) - Number(s.received_weight_kg)).toFixed(2),
              volume_cbm: Math.max(0, Number(s.volume_cbm) - Number(s.received_cbm)).toFixed(3), condition: 'good', location_id: d.locations[0]?.id ?? '' })}>Receive</button>}
            {d.can.verify && !s.cargo_verified_at && ['received', 'discrepancy'].includes(s.receiving_status) && <button className="btn small" onClick={() => s.receiving_status === 'discrepancy'
              ? ask({ action: 'verify_cargo', shipment_id: s.id }, 'There are differences — how were they settled?', 'Cargo verified.', 'note') : act({ action: 'verify_cargo', shipment_id: s.id }, 'Cargo verified.')}>Verify</button>}</td>
        </>, ['Rcvd pkgs', 'Rcvd kg', 'Rcvd CBM', 'Status', ''])}
        {rcv && <div className="panel" style={{ marginTop: 10 }}><h3 className="small">Receive cargo — {rcv.label}</h3><div className="grid g4">
          {[['packages', 'Packages *'], ['weight_kg', 'Weight kg'], ['volume_cbm', 'CBM'], ['inward_ref', 'Inward ref.']].map(([k, l]) =>
            <label key={k} className="f"><span>{l}</span><input value={rcv[k] ?? ''} onChange={(e) => setRcv({ ...rcv, [k]: e.target.value })} /></label>)}
          <label className="f"><span>Condition</span><select value={rcv.condition} onChange={(e) => setRcv({ ...rcv, condition: e.target.value })}>{CONDITIONS.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          {rcv.condition !== 'good' && <label className="f span2"><span>Damage / shortage *</span><input value={rcv.damage_note ?? ''} onChange={(e) => setRcv({ ...rcv, damage_note: e.target.value })} /></label>}
          <label className="f"><span>Location</span><select value={rcv.location_id} onChange={(e) => setRcv({ ...rcv, location_id: e.target.value })}><option value="">—</option>
            {d.locations.map((l: any) => <option key={l.id} value={l.id}>{l.code}{l.location_type !== 'storage' ? ` (${l.location_type})` : ''}</option>)}</select></label>
          <label className="f span2"><span>Remarks</span><input value={rcv.remarks ?? ''} onChange={(e) => setRcv({ ...rcv, remarks: e.target.value })} /></label>
        </div><div className="form-actions"><button className="btn" onClick={() => setRcv(null)}>Cancel</button>
          <button className="btn primary" onClick={async () => { const { label, ...b } = rcv; if (await act({ action: 'receive', ...b }, 'Cargo received.')) setRcv(null); }}>Save receipt</button></div></div>}
        {d.receipts.length > 0 && <><h3 className="small" style={{ marginTop: 14 }}>Receipts</h3>
          <div className="table-wrap"><table className="t"><thead><tr><th>When</th><th>HBL / owner</th><th className="num">Pkgs</th><th className="num">Kg</th><th className="num">CBM</th><th>Condition</th><th>Location</th><th>By</th></tr></thead>
            <tbody>{d.receipts.map((r: any) => { const s = d.shipments.find((x: any) => x.id === r.shipment_id); return <tr key={r.id} className={r.condition !== 'good' ? 'loss' : ''}>
              <td className="small">{fmtDateTime(r.received_at)}{r.inward_ref && <div className="muted">{r.inward_ref}</div>}</td><td>{s?.hbl_no ?? (s && owner(s))}</td>
              <td className="num">{r.packages}</td><td className="num">{n(r.weight_kg)}</td><td className="num">{n(r.volume_cbm, 3)}</td>
              <td className="small">{r.condition}{r.damage_note && `: ${r.damage_note}`}</td><td>{r.location_code ?? '—'}</td><td className="small">{r.received_by_name}</td></tr>; })}</tbody></table></div></>}
      </div>}

      {tab === 'container' && <div className="panel"><h2>Container details</h2><dl className="kv">
        <dt>Container type</dt><dd>{d.container_type ?? '—'}{d.capacity_cbm && <span className="muted small"> — {Number(d.capacity_cbm)} CBM, max {n(d.max_payload_kg, 0)} kg</span>}</dd>
        <dt>Container no.</dt><dd>{d.container_no ?? '—'}</dd><dt>Seal no.</dt><dd>{d.seal_no ?? '—'}</dd>
        <dt>Volume used</dt><dd>{bar(d.utilisation_pct)} <span className="muted small">{n(d.totals.cbm, 2)} CBM</span></dd>
        <dt>Payload used</dt><dd>{bar(d.totals.payload_pct)} <span className="muted small">{n(d.totals.weight_kg, 0)} kg</span></dd>
        <dt>Stuffing date</dt><dd>{fmtDate(d.stuffing_date)}{d.stuffed_at && <div className="muted small">completed {fmtDateTime(d.stuffed_at)} by {d.stuffed_by_name}</div>}</dd>
        <dt>Warehouse</dt><dd>{d.warehouse_name ?? '—'}</dd></dl>
        {d.can.edit && <button className="btn small" onClick={() => { setTab('overview'); setEdit({ ...d }); }}>Edit container details</button>}</div>}

      {tab === 'mbl' && <div className="panel"><h2>Master BL {d.mbl_no ?? '(not yet)'}</h2><dl className="kv">
        <dt>Shipping line</dt><dd>{d.carrier ?? '—'}</dd><dt>Carrier booking ID</dt><dd>{d.carrier_booking_id ?? '—'}</dd><dt>POL → POD</dt><dd>{[d.pol, d.pod].filter(Boolean).join(' → ') || '—'}</dd></dl>
        <h3 className="small" style={{ marginTop: 12 }}>House BLs under this Master BL</h3>
        {shipTable((s) => <td>{s.stuffing_status === 'shut_out' ? 'Shut out' : s.delivery_status === 'delivered' ? 'Delivered' : '—'}</td>, ['Status'])}
        <h3 className="small" style={{ marginTop: 12 }}>MBL documents</h3>
        {d.documents.filter((x: any) => x.doc_type.startsWith('mbl')).map((x: any) => <div key={x.id} className="small"><button className="linkish" onClick={() => openDoc(x.id)}>{x.file_name}</button>
          {' '}— {LCL_DOC_TYPES.find(([k]) => k === x.doc_type)?.[1]} v{x.version}{x.replaced_at && ' (replaced)'}</div>)}
        {!d.documents.some((x: any) => x.doc_type.startsWith('mbl')) && <p className="muted small">None yet — upload under Documents.</p>}</div>}

      {tab === 'documents' && <div className="panel"><h2>Documents</h2>
        <div className="table-wrap"><table className="t"><thead><tr><th>Document</th><th>Type</th><th>House shipment</th><th>Version</th><th>Uploaded</th><th /></tr></thead>
          <tbody>{d.documents.map((x: any) => <tr key={x.id} className={x.replaced_at ? 'muted' : ''}>
            <td><button className="linkish" onClick={() => openDoc(x.id)}>{x.file_name}</button>{x.description && <div className="muted small">{x.description}</div>}</td>
            <td className="small">{LCL_DOC_TYPES.find(([k]) => k === x.doc_type)?.[1]}</td><td>{d.shipments.find((s: any) => s.id === x.shipment_id)?.hbl_no ?? '—'}</td>
            <td>v{x.version}{x.replaced_at && ' (replaced)'}</td><td className="small">{fmtDateTime(x.uploaded_at)} · {x.uploaded_by_name}</td>
            <td>{d.can.documents && !x.replaced_at && <button className="btn small" onClick={() => setUpl({ doc_type: x.doc_type, shipment_id: x.shipment_id, replaces_id: x.id })}>New version</button>}</td></tr>)}
            {d.documents.length === 0 && <tr><td colSpan={6} className="muted">No documents yet.</td></tr>}</tbody></table></div>
        {d.can.documents && <div className="grid g4" style={{ marginTop: 10 }}>
          <label className="f"><span>Type</span><select value={upl.doc_type} onChange={(e) => setUpl({ ...upl, doc_type: e.target.value })}>{LCL_DOC_TYPES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
          <label className="f"><span>House shipment (for HBL documents)</span><select value={upl.shipment_id ?? ''} onChange={(e) => setUpl({ ...upl, shipment_id: e.target.value })}><option value="">Whole consolidation</option>
            {d.shipments.map((s: any) => <option key={s.id} value={s.id}>{s.hbl_no ?? owner(s)}</option>)}</select></label>
          <label className="f span2"><span>File{upl.replaces_id && ' (new version)'}</span><input type="file" onChange={(e) => setUpl({ ...upl, file: e.target.files?.[0] })} /></label>
          <div><button className="btn primary small" disabled={busy || !upl.file} onClick={upload}>{busy ? 'Uploading…' : 'Upload'}</button></div></div>}
      </div>}

      {tab === 'stuffing' && <div className="panel"><h2>Stuffing and dispatch</h2>
        <p className="small" style={{ marginTop: 0 }}>Status: <b>{d.status_name}</b>{d.container_no && <> · container <b>{d.container_no}</b></>}{d.seal_no && <> · seal <b>{d.seal_no}</b></>}</p>
        {shipTable((s) => <>
          <td>{s.cargo_verified_at ? 'Verified' : <span className="flag">Not verified</span>}</td>
          <td className="small">{pendingDocs(s) ? <span className="flag">HBL final missing</span> : s.hbl_no ? 'OK' : <span className="flag">No HBL</span>}</td>
          <td className="small">{s.stuffing_status === 'stuffed' ? 'Stuffed' : s.stuffing_status === 'shut_out' ? 'Shut out' : 'Pending'}</td>
          <td style={{ whiteSpace: 'nowrap' }}>{d.can.stuff && s.stuffing_status === 'pending' && <>
            <button className="btn small primary" disabled={!s.cargo_verified_at} onClick={() => act({ action: 'stuff_shipment', shipment_id: s.id, result: 'stuffed' }, 'Stuffed.')}>Stuffed</button>
            <button className="btn small" onClick={() => ask({ action: 'stuff_shipment', shipment_id: s.id, result: 'shut_out' }, 'Why is it shut out?', 'Shut out.')}>Shut out</button></>}
            {d.can.stuff && s.stuffing_status !== 'pending' && <button className="btn small" onClick={() => act({ action: 'stuff_shipment', shipment_id: s.id, result: 'pending' }, 'Back to pending.')}>Undo</button>}</td>
        </>, ['Cargo', 'Documents', 'Stuffing', ''])}
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 10 }}>
          {d.can.start_stuffing && <button className="btn primary" onClick={() => act({ action: 'start_stuffing' }, 'Stuffing started.')}>Start stuffing</button>}
          {d.can.complete_stuffing && <button className="btn primary" onClick={() => { const c = prompt('Container number', d.container_no ?? ''); if (c) act({ action: 'complete_stuffing', container_no: c }, 'Stuffing completed.'); }}>Stuffing completed</button>}
          {d.can.seal && <button className="btn primary" onClick={() => ask({ action: 'seal' }, 'Seal number', 'Container sealed.', 'seal_no')}>Container sealed</button>}
          {d.can.dispatch && <button className="btn primary" onClick={() => act({ action: 'dispatch' }, 'Container dispatched.')}>Container dispatched</button>}
          {d.status === 'open' && <span className="muted small">Verify every house shipment's cargo, then press "Ready for stuffing" at the top.</span>}
        </div>
        {d.can.delivered && <><h3 className="small" style={{ marginTop: 14 }}>Delivery per House BL</h3>
          {d.shipments.filter((s: any) => s.stuffing_status === 'stuffed').map((s: any) => <div key={s.id} className="small" style={{ padding: '3px 0' }}>{s.hbl_no ?? owner(s)} — {s.delivery_status === 'delivered'
            ? `delivered ${fmtDateTime(s.delivered_at)}` : <button className="btn small" onClick={() => act({ action: 'delivered', shipment_id: s.id }, 'Marked delivered.')}>Delivered</button>}</div>)}</>}
      </div>}

      {tab === 'milestones' && <div className="panel"><h2>Milestones</h2>
        <table className="t"><thead><tr><th>Step</th><th>Planned</th><th>Actual</th></tr></thead>
          <tbody>{d.milestones.map((m: any) => <tr key={m.name}><td>{m.name}</td><td>{fmtDate(m.planned)}</td><td>{m.actual ? fmtDateTime(m.actual) : '—'}</td></tr>)}</tbody></table>
        <p className="muted small">When the container departs or arrives, each linked shipment gets that date only where it has no date of its own yet; its own events are never overwritten.</p></div>}

      {tab === 'history' && <div className="panel"><h2>Activity history</h2>
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}><input id="lclnote" placeholder="Add a note…" style={{ flex: 1 }} />
          <button className="btn small" onClick={async () => { const el = document.getElementById('lclnote') as HTMLInputElement; if (el.value.trim() && await act({ action: 'note', note: el.value }, 'Note added.')) el.value = ''; }}>Add</button></div>
        {[...d.events].reverse().map((e: any, i: number) => <div key={i} className="small" style={{ padding: '5px 0', borderTop: '1px solid var(--line-soft)' }}>
          <b>{e.title}</b>{e.old_value && e.new_value ? <>: {e.old_value} → {e.new_value}</> : e.new_value ? <>: {e.new_value}</> : null}
          {e.remarks && <div>Remarks: {e.remarks}</div>}<div className="muted">{fmtDateTime(e.at)} · {e.user_name}</div></div>)}</div>}
    </div>
  );
}
