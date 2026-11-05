'use client';
/** The consolidation header: route, carrier, booking, container, MBL, dates, warehouse — in sections. */
import { DIVISIONS } from '@/lib/commercialRules';

export function LclHeadForm({ f, setF, types, warehouses, vendors }: { f: any; setF: (v: any) => void; types: any[]; warehouses: any[]; vendors: any[] }) {
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const inp = (k: string, label: string, extra: any = {}) => <label className="f"><span>{label}</span><input value={f[k] ?? ''} onChange={set(k)} {...extra} /></label>;
  const date = (k: string, label: string) => <label className="f"><span>{label}</span><input type="date" value={f[k] ?? ''} onChange={set(k)} /></label>;
  return <>
    <div className="panel"><h2>Route</h2><div className="grid g4">
      <label className="f"><span>Division</span><select value={f.division ?? ''} onChange={set('division')}><option value="">—</option>{DIVISIONS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
      <label className="f"><span>Direction</span><select value={f.direction ?? 'export'} onChange={set('direction')}><option value="export">Export</option><option value="import">Import</option><option value="cross_trade">Cross-trade</option></select></label>
      {inp('origin', 'Origin')}{inp('destination', 'Destination')}
      {inp('pol', 'Port of loading *')}{inp('pod', 'Port of discharge *')}
    </div></div>
    <div className="panel"><h2>Carrier and container</h2><div className="grid g4">
      {inp('carrier', 'Shipping line')}
      <label className="f"><span>Line / co-loader (vendor)</span><select value={f.carrier_vendor_id ?? ''} onChange={set('carrier_vendor_id')}><option value="">—</option>
        {vendors.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      {inp('carrier_booking_id', 'Carrier booking ID')}{inp('mbl_no', 'Master BL no.')}
      <label className="f"><span>Container type</span><select value={f.container_type ?? ''} onChange={set('container_type')}><option value="">—</option>
        {types.map((t: any) => <option key={t.code} value={t.code}>{t.code} — {t.name} ({Number(t.capacity_cbm)} CBM)</option>)}</select></label>
      {inp('container_no', 'Container no.', { placeholder: 'can be added at stuffing' })}{inp('seal_no', 'Seal no.', { placeholder: 'added at sealing' })}
      <label className="f"><span>Warehouse (receiving and stuffing)</span><select value={f.warehouse_id ?? ''} onChange={set('warehouse_id')}><option value="">—</option>
        {warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.name}</option>)}</select></label>
    </div></div>
    <div className="panel"><h2>Dates</h2><div className="grid g4">
      {date('receiving_deadline', 'Cargo receiving deadline')}{date('cutoff_date', 'Consolidation cut-off')}{date('stuffing_date', 'Stuffing date')}{date('etd', 'ETD')}{date('eta', 'ETA')}
      <label className="f span3"><span>Remarks</span><input value={f.remarks ?? ''} onChange={set('remarks')} /></label>
    </div></div>
  </>;
}
