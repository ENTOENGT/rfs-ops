'use client';
import { useMe } from './Shell';
import { DIVISIONS } from '@/lib/commercialRules';
import { DIRECTIONS, MODES, INCOTERMS } from '@/lib/jobfileRules';

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
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const air = f.mode === 'air', road = f.mode === 'road';
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
          <select value={f.salesman_id ?? ''} onChange={(e) => setF({ ...f, salesman_id: e.target.value, division: f.division || lk.salesmen?.find((s: any) => s.id === e.target.value)?.division || '' })}>
            <option value="">{me.role_code === 'coordinator' ? 'Choose the Salesman' : 'None'}</option>
            {lk.salesmen?.map((s: any) => <option key={s.id} value={s.id}>{s.name}</option>)}</select><Err m={fe.salesman_id} /></label>}
        {enquiry && <div className="f"><span>Coordinator</span>
          {manager ? <select value={f.coordinator_id ?? ''} onChange={set('coordinator_id')}><option value="">{coordName ? `${coordName} (from the mapping)` : 'From the Salesman\'s mapping'}</option>
            {lk.coordinators?.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            : <input readOnly value={coordName ?? (me.role_code === 'sales' ? 'None mapped — ask the Commercials Manager' : 'Comes from the Salesman')} />}</div>}
        {enquiry && <label className="f"><span>Division</span><select value={f.division ?? ''} onChange={set('division')}
          disabled={!manager && !!(me.role_code === 'sales' ? true : salesman?.division)}>
          <option value="">{salesman?.division || me.role_code === 'sales' ? 'The Salesman\'s division' : 'From the direction'}</option>
          {DIVISIONS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>}
        <label className={`f${fe.direction ? ' bad' : ''}`}><span>Direction <em>*</em></span>
          <select value={f.direction ?? ''} onChange={set('direction')}><option value="">Choose</option>
            {DIRECTIONS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select><Err m={fe.direction} /></label>
        <label className={`f${fe.mode ? ' bad' : ''}`}><span>Mode <em>*</em></span>
          <select value={f.mode ?? ''} onChange={set('mode')}><option value="">Choose</option>
            {MODES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select><Err m={fe.mode} /></label>
        <label className="f"><span>Customer reference</span><input value={f.customer_reference ?? ''} onChange={set('customer_reference')} /></label>
        <label className="f"><span>Incoterm</span><select value={f.incoterm ?? ''} onChange={set('incoterm')}><option value="">—</option>
          {INCOTERMS.map((t) => <option key={t}>{t}</option>)}</select></label>
      </div>
      <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 12 }}>
        {tick('needs_clearance', 'Needs customs clearance (PRO)')}{tick('needs_transport', 'Needs transport')}{tick('needs_warehouse', 'Goes into our warehouse')}
      </div>
      {isNew && <p className="muted small" style={{ marginBottom: 0 }}>These decide the milestone plan and what must be finished before the Job File can close.</p>}
    </div>
    <div className="panel"><h2>Parties</h2><div className="grid g3">
      <label className="f"><span>Shipper</span><textarea rows={2} value={f.shipper ?? ''} onChange={set('shipper')} /></label>
      <label className="f"><span>Consignee</span><textarea rows={2} value={f.consignee ?? ''} onChange={set('consignee')} /></label>
      <label className="f"><span>Notify party</span><textarea rows={2} value={f.notify_party ?? ''} onChange={set('notify_party')} /></label>
    </div></div>
    <div className="panel"><h2>Route and carrier</h2><div className="grid g3">
      <label className="f"><span>Origin (city / country)</span><input value={f.origin ?? ''} onChange={set('origin')} /></label>
      <label className="f"><span>{air ? 'Airport of departure' : road ? 'Loading point' : 'Port of loading'}</span><input value={f.port_of_loading ?? ''} onChange={set('port_of_loading')} /></label>
      <label className="f"><span>{air ? 'Airport of arrival' : road ? 'Border / unloading point' : 'Port of discharge'}</span><input value={f.port_of_discharge ?? ''} onChange={set('port_of_discharge')} /></label>
      <label className="f"><span>Final destination</span><input value={f.destination ?? ''} onChange={set('destination')} /></label>
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
    </div></div>
    <div className="panel"><h2>Cargo</h2><div className="grid g4">
      <label className="f"><span>Packages</span><input type="number" min={0} value={f.packages ?? ''} onChange={set('packages')} /></label>
      <label className="f"><span>Gross weight (kg)</span><input type="number" min={0} step="0.01" value={f.gross_weight_kg ?? ''} onChange={set('gross_weight_kg')} /></label>
      <label className="f"><span>Volume (CBM)</span><input type="number" min={0} step="0.001" value={f.volume_cbm ?? ''} onChange={set('volume_cbm')} /></label>
      <label className="f"><span>Chargeable weight (kg)</span><input type="number" min={0} step="0.01" value={f.chargeable_weight_kg ?? ''} onChange={set('chargeable_weight_kg')} /></label>
      <label className="f span2"><span>Cargo description</span><textarea rows={2} value={f.cargo_description ?? ''} onChange={set('cargo_description')} /></label>
      <label className="f span2"><span>Remarks</span><textarea rows={2} value={f.remarks ?? ''} onChange={set('remarks')} /></label>
    </div></div>
  </>;
}
