'use client';
import { useEffect } from 'react';
import { useMe } from './Shell';
import { DIVISIONS, directionOfDivision, divisionName } from '@/lib/commercialRules';
import { DIRECTIONS, MODES, INCOTERMS, label } from '@/lib/jobfileRules';
import { INCOTERM_INFO, incotermNeeds, incotermRequired } from '@/lib/incotermRules';
import { CURRENCIES } from '@/lib/currency';
import { PACKAGE_TYPES, DIM_UNITS, blankLine, cargoTotals, dimsRequired, lineCbm, typedLines } from '@/lib/cargoRules';

const Err = ({ m }: { m?: string }) => (m ? <small className="ferr">{m}</small> : null);

/** The Job File fields, shared by "New Job File" and "Edit" so both check and look the same. */
export function JobFileFields({ f, setF, fe = {}, isNew }: { f: any; setF: (v: any) => void; fe?: Record<string, string>; isNew?: boolean }) {
  const { lk, me, can } = useMe();
  const enquiry = isNew && f.status === 'enquiry';
  // Part E: the Coordinator comes from the Salesman's mapping
  const salesmanId = me.role_code === 'sales' ? me.id : f.salesman_id;
  const salesman = lk.salesmen?.find((s: any) => s.id === salesmanId);
  const coordId = me.role_code === 'sales' ? lk.me_coordinator_id : salesman?.coordinator_id ?? (me.role_code === 'coordinator' ? me.id : null);
  const coordName = lk.coordinators?.find((c: any) => c.id === (f.coordinator_id || coordId))?.name;
  const manager = can('commercial.manage');
  const defDivision = salesman?.division ?? (me.role_code === 'sales' ? me.division : null);
  // start a new enquiry on the Salesman's own division, so the direction (and the Incoterm rules) are right from the start
  useEffect(() => {
    if (enquiry && !f.division && defDivision) setF({ ...f, division: defDivision, direction: directionOfDivision(defDivision) });
  }, [enquiry, defDivision]);  // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const air = f.mode === 'air', road = f.mode === 'road';
  // Step 3: at enquiry stage the customer doesn't choose the carrier — vessel, booking, BL and dates come later from booking / pre-alert
  const enq = f.status === 'enquiry';
  const terms = incotermNeeds(f.incoterm, f.direction, !!f.needs_transport);
  const own = lk.my_department?.side === 'operations';
  const tick = (k: string, text: string) => (
    <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
      <input type="checkbox" style={{ width: 'auto' }} checked={!!f[k]} onChange={set(k)} />{text}</label>);
  return <>
    <div className="panel"><h2>Shipment</h2>
      {isNew && !own && !enquiry && <label className="f" style={{ maxWidth: 320, marginBottom: 12 }}><span>Department</span>
        <select value={f.department_id ?? ''} onChange={set('department_id')}><option value="">None</option>
          {lk.departments.filter((d: any) => d.side === 'operations').map((d: any) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
      <div className="grid g3">
        {isNew && !enquiry && <label className={`f${fe.job_no ? ' bad' : ''}`}><span>Job No. (from the ERP) <em>*</em></span>
          <input value={f.job_no ?? ''} onChange={set('job_no')} autoFocus maxLength={40} /><Err m={fe.job_no} /></label>}
        <label className={`f ${isNew && !enquiry ? 'span2' : ''}${fe.customer_id ? ' bad' : ''}`}><span>Customer <em>*</em></span>
          <select value={f.customer_id ?? ''} onChange={set('customer_id')}><option value="">Choose customer</option>
            {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select><Err m={fe.customer_id} /></label>
        {enquiry && me.role_code !== 'sales' && <label className={`f${fe.salesman_id ? ' bad' : ''}`}><span>Responsible Salesman {me.role_code === 'coordinator' && <em>*</em>}</span>
          <select value={f.salesman_id ?? ''} onChange={(e) => { const dv = f.division || lk.salesmen?.find((s: any) => s.id === e.target.value)?.division || ''; setF({ ...f, salesman_id: e.target.value, division: dv, direction: directionOfDivision(dv) ?? f.direction }); }}>
            <option value="">{me.role_code === 'coordinator' ? 'Choose the Salesman' : 'None'}</option>
            {lk.salesmen?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select><Err m={fe.salesman_id} /></label>}
        {enquiry && <div className="f"><span>Coordinator</span>
          {manager ? <select value={f.coordinator_id ?? ''} onChange={set('coordinator_id')}><option value="">{coordName ? `${coordName} (from the mapping)` : 'From the Salesman\'s mapping'}</option>
            {lk.coordinators?.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            : <input readOnly value={coordName ?? (me.role_code === 'sales' ? 'None mapped — ask the Commercials Manager' : 'Comes from the Salesman')} />}</div>}
        {/* Step 4: an enquiry asks one thing — the division; the direction follows it (Imports → import, Exports → export, Cross Trade → cross-trade) */}
        {enquiry && <label className={`f${fe.division || fe.direction ? ' bad' : ''}`}><span>Division <em>*</em></span>
          <select value={f.division || ''} onChange={(e) => setF({ ...f, division: e.target.value, direction: directionOfDivision(e.target.value) ?? '' })}>
            <option value="">Choose</option>
            {DIVISIONS.map(([c, n]) => <option key={c} value={c}>{n} — {DIRECTIONS.find(([d]) => d === directionOfDivision(c))?.[1].toLowerCase()} shipments</option>)}</select>
          <Err m={fe.division || fe.direction} /></label>}
        {!isNew && f.status === 'enquiry' && <div className="f"><span>Division</span><input readOnly value={`${divisionName(f.division)} — ${label(DIRECTIONS, f.direction)}`} title="Fixed: it is part of the Enquiry Ref" /></div>}
        {f.status !== 'enquiry' && <label className={`f${fe.direction ? ' bad' : ''}`}><span>Direction <em>*</em></span>
          <select value={f.direction ?? ''} onChange={set('direction')}><option value="">Choose</option>
            {DIRECTIONS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select><Err m={fe.direction} /></label>}
        <label className={`f${fe.mode ? ' bad' : ''}`}><span>Mode <em>*</em></span>
          <select value={f.mode ?? ''} onChange={set('mode')}><option value="">Choose</option>
            {MODES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select><Err m={fe.mode} /></label>
        <label className="f"><span>Customer reference</span><input value={f.customer_reference ?? ''} onChange={set('customer_reference')} /></label>
      </div>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 12 }}>
        {tick('needs_clearance', 'Needs customs clearance (PRO)')}{tick('needs_transport', 'Needs transport')}{tick('needs_warehouse', 'Goes into our warehouse')}
      </div>
      {isNew && <p className="muted small" style={{ marginBottom: 0 }}>These decide the milestone plan and what must be finished before the Job File can close.</p>}
    </div>
    <TermsPanel f={f} setF={setF} fe={fe} />
    <div className="panel"><h2>Parties</h2><div className="grid g3">
      <label className="f"><span>Shipper</span><textarea rows={2} value={f.shipper ?? ''} onChange={set('shipper')} /></label>
      <label className="f"><span>Consignee</span><textarea rows={2} value={f.consignee ?? ''} onChange={set('consignee')} /></label>
      <label className="f"><span>Notify party</span><textarea rows={2} value={f.notify_party ?? ''} onChange={set('notify_party')} /></label>
    </div></div>
    <div className="panel"><h2>{enq ? 'Route' : 'Route and carrier'}</h2><div className="grid g3">
      <label className="f"><span>Origin (city / country)</span><input value={f.origin ?? ''} onChange={set('origin')} /></label>
      <label className={`f${fe.port_of_loading ? ' bad' : ''}`}><span>{air ? 'Airport of departure' : road ? 'Loading point' : 'Port of loading'}{terms.need.has('port_of_loading') && <em> *</em>}</span>
        <input value={f.port_of_loading ?? ''} onChange={set('port_of_loading')} /><Err m={fe.port_of_loading} /></label>
      <label className={`f${fe.port_of_discharge ? ' bad' : ''}`}><span>{air ? 'Airport of arrival' : road ? 'Border / unloading point' : 'Port of discharge'}{terms.need.has('port_of_discharge') && <em> *</em>}</span>
        <input value={f.port_of_discharge ?? ''} onChange={set('port_of_discharge')} /><Err m={fe.port_of_discharge} /></label>
      <label className="f"><span>Final destination</span><input value={f.destination ?? ''} onChange={set('destination')} /></label>
      {!enq && <>
      <label className="f"><span>{air ? 'Airline' : road ? 'Transporter' : 'Shipping line'}</span><input value={f.carrier ?? ''} onChange={set('carrier')} /></label>
      <label className="f"><span>{air ? 'Flight' : road ? 'Truck / trip' : 'Vessel'}</span><input value={f.vessel_flight ?? ''} onChange={set('vessel_flight')} /></label>
      {!air && !road && <label className="f"><span>Voyage</span><input value={f.voyage ?? ''} onChange={set('voyage')} /></label>}
      <label className="f"><span>Carrier booking ref.</span><input value={f.booking_reference ?? ''} onChange={set('booking_reference')} /></label>
      <label className="f"><span>{air ? 'MAWB' : 'MBL'}</span><input value={f.mbl_mawb ?? ''} onChange={set('mbl_mawb')} /></label>
      <label className="f"><span>{air ? 'HAWB' : 'HBL'}</span><input value={f.hbl_hawb ?? ''} onChange={set('hbl_hawb')} /></label>
      <label className="f"><span>ETD</span><input type="date" value={f.etd ?? ''} onChange={set('etd')} /></label>
      <label className="f"><span>ETA</span><input type="date" value={f.eta ?? ''} onChange={set('eta')} /></label>
      {!isNew && <>
        <label className="f"><span>Actual departure</span><input type="date" value={f.atd ?? ''} onChange={set('atd')} /></label>
        <label className="f"><span>Actual arrival</span><input type="date" value={f.ata ?? ''} onChange={set('ata')} /></label></>}
      </>}
    </div>
      {enq && <p className="muted small" style={{ marginBottom: 0 }}>Shipping line, vessel, booking, BL and dates are not asked here — they come from the Booking, Vessel details and Pre-alert steps.</p>}
    </div>
    <CargoPanel f={f} setF={setF} fe={fe} />
  </>;
}

/** Cargo (migration 023): one line per package type and size; packages, weight, CBM and chargeable weight add up by themselves. */
function CargoPanel({ f, setF, fe }: { f: any; setF: (v: any) => void; fe: Record<string, string> }) {
  const lines: any[] = f.cargo_lines ?? [];
  const setLines = (v: any[]) => setF({ ...f, cargo_lines: v });
  const setLine = (i: number, k: string, v: string) => setLines(lines.map((l, j) => j === i ? { ...l, [k]: v } : l));
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const t = cargoTotals(typedLines(lines), f.mode);
  const fmt = (v: number, d = 2) => v.toLocaleString('en-US', { maximumFractionDigits: d });
  const need = dimsRequired(f.mode);
  const old = !lines.length && (f.packages || f.gross_weight_kg || f.volume_cbm);
  return <div className="panel"><h2>Cargo</h2>
    <p className="muted small" style={{ marginTop: 0 }}>
      {need ? 'Add one line for each package type and size. ' : 'Full container: dimensions are optional. '}
      Total packages, weight and CBM add up by themselves{f.mode === 'air' ? ', and so does the chargeable weight' : ''}.</p>
    {lines.length > 0 && <div className="cargo-lines">
      <div className="cargo-row cargo-headrow"><span>Package type</span><span>No. of pkgs</span><span>Length</span><span>Width</span><span>Height</span><span>Unit</span><span>Weight (kg)</span><span>CBM</span><span /></div>
      {lines.map((l, i) => <div key={i} className="cargo-row">
        <span className="cargo-type">
          <select aria-label="Package type" value={l.package_type} onChange={(e) => setLine(i, 'package_type', e.target.value)}>{PACKAGE_TYPES.map((p) => <option key={p}>{p}</option>)}</select>
          {l.package_type === 'Other' && <input aria-label="Other package type" placeholder="Type it" value={l.package_other ?? ''} onChange={(e) => setLine(i, 'package_other', e.target.value)} />}
        </span>
        <label className="cl"><i>No. of pkgs</i><input aria-label="Number of packages" placeholder="No. of pkgs" type="number" min={1} step={1} value={l.pieces} onChange={(e) => setLine(i, 'pieces', e.target.value)} /></label>
        <label className="cl"><i>Length</i><input aria-label="Length" placeholder="Length" type="number" min={0} step="0.01" value={l.length} onChange={(e) => setLine(i, 'length', e.target.value)} /></label>
        <label className="cl"><i>Width</i><input aria-label="Width" placeholder="Width" type="number" min={0} step="0.01" value={l.width} onChange={(e) => setLine(i, 'width', e.target.value)} /></label>
        <label className="cl"><i>Height</i><input aria-label="Height" placeholder="Height" type="number" min={0} step="0.01" value={l.height} onChange={(e) => setLine(i, 'height', e.target.value)} /></label>
        <label className="cl"><i>Unit</i><select aria-label="Unit" value={l.dim_unit} onChange={(e) => setLine(i, 'dim_unit', e.target.value)}>{DIM_UNITS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>
        <label className="cl"><i>Weight (kg)</i><input aria-label="Weight in kg, all packages in this line" placeholder="Weight kg" type="number" min={0} step="0.01" value={l.weight_kg} onChange={(e) => setLine(i, 'weight_kg', e.target.value)} /></label>
        <b className="num"><i className="cl-i">CBM </i>{fmt(lineCbm(l), 3)}</b>
        <button type="button" className="icon-btn" title="Remove this line" aria-label="Remove this line" disabled={need && lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button>
      </div>)}
    </div>}
    {fe.cargo_lines && <small className="ferr" style={{ display: 'block', marginTop: 6 }}>{fe.cargo_lines}</small>}
    <button type="button" className="btn small" style={{ marginTop: 10 }} onClick={() => setLines([...lines, blankLine(lines[lines.length - 1])])}>+ Add {lines.length ? 'another size' : 'dimensions'}</button>
    {lines.length > 0 ? <div className="cargo-totals">
      <div><span>Total packages</span><b>{fmt(t.packages, 0)}{t.package_type ? ` ${t.package_type.toLowerCase()}` : ''}</b></div>
      <div><span>Total weight</span><b>{fmt(t.weight)} kg</b></div>
      <div><span>Total volume</span><b>{fmt(t.cbm, 3)} CBM</b></div>
      {t.chargeable_kg !== null && <div><span>Chargeable weight</span><b>{fmt(t.chargeable_kg)} kg</b><small>volumetric {fmt(t.volumetric_kg ?? 0)} kg</small></div>}
      {t.wm !== null && <div><span>Weight / measure</span><b>{fmt(t.wm, 3)} W/M</b></div>}
    </div> : old ? <div className="grid g4" style={{ marginTop: 12 }}>
      <label className="f"><span>Packages</span><input type="number" min={0} value={f.packages ?? ''} onChange={set('packages')} /></label>
      <label className="f"><span>Gross weight (kg)</span><input type="number" min={0} step="0.01" value={f.gross_weight_kg ?? ''} onChange={set('gross_weight_kg')} /></label>
      <label className="f"><span>Volume (CBM)</span><input type="number" min={0} step="0.001" value={f.volume_cbm ?? ''} onChange={set('volume_cbm')} /></label>
      <label className="f"><span>Chargeable weight (kg)</span><input type="number" min={0} step="0.01" value={f.chargeable_weight_kg ?? ''} onChange={set('chargeable_weight_kg')} /></label>
    </div> : null}
    <div className="grid g2" style={{ marginTop: 14 }}>
      <label className="f"><span>Cargo description</span><textarea rows={2} value={f.cargo_description ?? ''} onChange={set('cargo_description')} /></label>
      <label className="f"><span>Remarks</span><textarea rows={2} value={f.remarks ?? ''} onChange={set('remarks')} /></label>
    </div>
  </div>;
}

/** Incoterm and the addresses it needs (migration 023): only the fields this term needs are shown, and they are required. */
function TermsPanel({ f, setF, fe }: { f: any; setF: (v: any) => void; fe: Record<string, string> }) {
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const { need, scope, notes } = incotermNeeds(f.incoterm, f.direction, !!f.needs_transport);
  const info = INCOTERM_INFO[f.incoterm ?? ''];
  const has = (k: string) => need.has(k as any) || !!f[k];
  const star = (k: string) => need.has(k as any) ? <em> *</em> : null;
  const box = (k: string, label: string, ph: string, contact?: string) => <div className="terms-addr">
    <label className={`f${fe[k] ? ' bad' : ''}`}><span>{label}{star(k)}</span><textarea rows={2} value={f[k] ?? ''} onChange={set(k)} placeholder={ph} /><Err m={fe[k]} /></label>
    {contact && <label className="f"><span>Contact person and phone</span><input value={f[contact] ?? ''} onChange={set(contact)} placeholder="Name, +971 …" /></label>}
  </div>;
  return <div className="panel"><h2>Incoterm and addresses</h2>
    <div className="terms-top">
      <label className={`f${fe.incoterm ? ' bad' : ''}`} style={{ maxWidth: 260 }}><span>Incoterm{incotermRequired(f.direction) && f.status === 'enquiry' && <em> *</em>}</span>
        <select value={f.incoterm ?? ''} onChange={set('incoterm')}><option value="">Choose</option>
          {INCOTERMS.map((t) => <option key={t} value={t}>{t} — {INCOTERM_INFO[t].name}</option>)}</select><Err m={fe.incoterm} /></label>
      {info ? <div className="terms-info"><b>{f.incoterm} — {info.name}</b><span>{info.text}</span>
        {scope && <span className="terms-scope">{f.direction === 'import' ? 'Our customer buys' : 'Our customer sells'}: {scope}</span>}
        {notes.map((n) => <span key={n} className="terms-note">{n}</span>)}</div>
        : <div className="terms-info muted"><span>Choose the Incoterm. It decides which addresses and details this enquiry needs.</span></div>}
    </div>
    {(has('pickup_address') || has('named_place') || has('delivery_address') || has('cargo_value')) && <div className="terms-grid">
      {has('pickup_address') && box('pickup_address', 'Pickup (loading) address', 'Company, building, street, city, country', 'pickup_contact')}
      {has('named_place') && box('named_place', 'Handover place (named place)', 'e.g. carrier\'s warehouse, Shanghai')}
      {has('delivery_address') && box('delivery_address', 'Delivery address', 'Company, building, street, city, country', 'delivery_contact')}
      {has('cargo_value') && <div className="terms-addr"><div className="grid g2">
        <label className={`f${fe.cargo_value ? ' bad' : ''}`}><span>Cargo value (for insurance){star('cargo_value')}</span>
          <input type="number" min={0} step="0.01" value={f.cargo_value ?? ''} onChange={set('cargo_value')} /><Err m={fe.cargo_value} /></label>
        <label className="f"><span>Currency{star('cargo_value')}</span><select value={f.cargo_value_currency ?? ''} onChange={(e) => setF({ ...f, cargo_value_currency: e.target.value })}><option value="">Choose</option>
          {CURRENCIES.map(([c, n]) => <option key={c} value={c}>{c} — {n}</option>)}</select></label>
      </div></div>}
    </div>}
    {[...need].some((k) => k === 'port_of_loading' || k === 'port_of_discharge') && <p className="muted small" style={{ marginBottom: 0 }}>
      {[...need].filter((k) => k.startsWith('port_')).map((k) => k === 'port_of_loading' ? 'Port of loading' : 'Port of discharge').join(' and ')} — fill in under Route below.</p>}
  </div>;
}
