'use client';
import { useEffect, useState } from 'react';
import { api } from '@/components/api';
import { useMe } from '@/components/Shell';
import { WhTabs, qtyFmt, useWhConfig } from '@/components/WarehouseShared';

const TYPES: [string, string][] = [['storage', 'Storage'], ['receiving', 'Receiving'], ['dispatch', 'Dispatch'], ['quarantine', 'Quarantine'], ['damaged', 'Damaged']];
const UOMS = ['piece', 'carton', 'pallet', 'kg', 'litre', 'set'];

export default function Setup() {
  const { lk } = useMe();
  const { cfg, reload } = useWhConfig();
  const [whId, setWhId] = useState('');
  const [newWh, setNewWh] = useState<any>(null);
  const [bins, setBins] = useState({ codes: '', zone: '', location_type: 'storage' });
  const [skuCust, setSkuCust] = useState('');
  const [skus, setSkus] = useState<any[]>([]);
  const [sku, setSku] = useState<any>(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  useEffect(() => { if (cfg && !whId && cfg.warehouses[0]) setWhId(cfg.warehouses[0].id); }, [cfg]);
  const loadSkus = () => api(`/api/warehouse?view=skus&active=all${skuCust ? `&customer_id=${skuCust}` : ''}`).then(setSkus).catch(() => {});
  useEffect(() => { loadSkus(); }, [skuCust]);
  const send = async (body: any, done: string) => {
    setErr(''); setOk('');
    try { await api('/api/warehouse', { body }); setOk(done); reload(); loadSkus(); return true; } catch (e: any) { setErr(e.message); return false; }
  };
  if (!cfg) return <div className="page muted">Loading…</div>;
  const canCfg = cfg.can.configure;
  const locs = cfg.locations.filter((l: any) => l.warehouse_id === whId);
  return (
    <div className="page">
      <div className="page-head"><h1>Warehouse</h1></div>
      <WhTabs />
      {err && <div className="msg err">{err}</div>}
      {ok && <div className="msg ok">{ok}</div>}
      <div className="cols">
        <div>
          <div className="panel"><div className="page-head" style={{ marginBottom: 8 }}><h2 style={{ margin: 0 }}>Bins</h2><span className="spacer" />
            <select style={{ width: 'auto' }} value={whId} onChange={(e) => setWhId(e.target.value)}>
              {cfg.warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></div>
            {canCfg && <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              <input style={{ flex: 3, minWidth: 220 }} value={bins.codes} onChange={(e) => setBins({ ...bins, codes: e.target.value })} placeholder="A-01-01, A-01-02  or  A-01-01 to A-01-20" />
              <input style={{ flex: 1, minWidth: 80 }} value={bins.zone} onChange={(e) => setBins({ ...bins, zone: e.target.value })} placeholder="Zone" />
              <select style={{ flex: 1, minWidth: 110 }} value={bins.location_type} onChange={(e) => setBins({ ...bins, location_type: e.target.value })}>
                {TYPES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select>
              <button className="btn" disabled={!bins.codes.trim()} onClick={async () => { if (await send({ action: 'locations', warehouse_id: whId, ...bins }, 'Bins added')) setBins({ ...bins, codes: '' }); }}>Add bins</button></div>}
            <div className="table-wrap"><table className="t"><thead><tr><th>Bin</th><th>Zone</th><th>Type</th><th className="num">Qty</th><th /></tr></thead>
              <tbody>{locs.map((l: any) => <tr key={l.id} style={l.is_active ? undefined : { opacity: 0.5 }}><td><b>{l.code}</b></td><td>{l.zone ?? '—'}</td>
                <td>{TYPES.find(([c]) => c === l.location_type)?.[1]}</td><td className="num">{qtyFmt(l.qty)}</td>
                <td style={{ textAlign: 'right' }}>{canCfg && <button className="btn small" onClick={() => send({ action: 'locations', id: l.id, is_active: !l.is_active }, l.is_active ? 'Bin switched off' : 'Bin switched on')}>
                  {l.is_active ? 'Switch off' : 'Switch on'}</button>}</td></tr>)}</tbody></table></div>
          </div>
          <div className="panel"><div className="page-head" style={{ marginBottom: 8 }}><h2 style={{ margin: 0 }}>SKUs (each belongs to one customer)</h2><span className="spacer" />
            <select style={{ width: 'auto' }} value={skuCust} onChange={(e) => setSkuCust(e.target.value)}><option value="">All customers</option>
              {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
            {canCfg && <button className="btn" onClick={() => setSku({ customer_id: skuCust, uom: 'piece' })}>Add SKU</button>}</div>
            <div className="table-wrap"><table className="t"><thead><tr><th>Customer</th><th>SKU</th><th>Product</th><th>Unit</th><th>Tracks</th><th className="num">In stock</th><th /></tr></thead>
              <tbody>{skus.map((s) => <tr key={s.id} style={s.is_active ? undefined : { opacity: 0.5 }}><td>{s.customer_name}</td><td><b>{s.sku_code}</b>{s.barcode && <div className="muted small">{s.barcode}</div>}</td>
                <td>{s.name}</td><td>{s.uom}{s.units_per_carton && <div className="muted small">{s.units_per_carton}/carton</div>}</td>
                <td className="small">{[s.track_batch && 'Batch', s.track_expiry && 'Expiry'].filter(Boolean).join(', ') || '—'}</td><td className="num">{qtyFmt(s.on_hand)}</td>
                <td>{canCfg && <button className="btn small" onClick={() => setSku({ ...s })}>Edit</button>}</td></tr>)}
                {skus.length === 0 && <tr><td colSpan={7} className="muted">No SKUs yet.</td></tr>}</tbody></table></div>
          </div>
        </div>
        <div>
          <div className="panel"><h2>Warehouses</h2>
            {cfg.warehouses.map((w: any) => <div key={w.id} className="small" style={{ padding: '4px 0' }}><b>{w.code}</b> — {w.name} <span className="muted">· {w.bins} bins{!w.is_active && ' · off'}</span></div>)}
            {canCfg && !newWh && <button className="btn small" style={{ marginTop: 8 }} onClick={() => setNewWh({ code: '', name: '', address: '' })}>Add warehouse</button>}
            {newWh && <div className="grid" style={{ marginTop: 10 }}>
              <label className="f"><span>Code</span><input value={newWh.code} onChange={(e) => setNewWh({ ...newWh, code: e.target.value.toUpperCase() })} placeholder="e.g. WH2" /></label>
              <label className="f"><span>Name</span><input value={newWh.name} onChange={(e) => setNewWh({ ...newWh, name: e.target.value })} /></label>
              <label className="f"><span>Address</span><input value={newWh.address} onChange={(e) => setNewWh({ ...newWh, address: e.target.value })} /></label>
              <div className="actions"><button className="btn" onClick={() => setNewWh(null)}>Cancel</button>
                <button className="btn primary" onClick={async () => { if (await send({ action: 'warehouse', ...newWh }, 'Warehouse added with Receiving, Dispatch, Quarantine and Damaged areas')) setNewWh(null); }}>Save</button></div>
            </div>}
            <p className="muted small">Each new warehouse starts with Receiving, Dispatch, Quarantine and Damaged areas. Add storage bins on the left.</p>
          </div>
        </div>
      </div>
      {sku && <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setSku(null)}><div className="modal" role="dialog" aria-label="SKU">
        <h2>{sku.id ? `Edit ${sku.sku_code}` : 'Add SKU'}</h2>
        <div className="grid g2">
          <label className="f span2"><span>Customer (owner)</span><select value={sku.customer_id ?? ''} onChange={(e) => setSku({ ...sku, customer_id: e.target.value })}><option value="">Choose customer</option>
            {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
          <label className="f"><span>SKU code</span><input value={sku.sku_code ?? ''} onChange={(e) => setSku({ ...sku, sku_code: e.target.value })} /></label>
          <label className="f"><span>Barcode</span><input value={sku.barcode ?? ''} onChange={(e) => setSku({ ...sku, barcode: e.target.value })} /></label>
          <label className="f span2"><span>Product name</span><input value={sku.name ?? ''} onChange={(e) => setSku({ ...sku, name: e.target.value })} /></label>
          <label className="f"><span>Unit</span><select value={sku.uom} onChange={(e) => setSku({ ...sku, uom: e.target.value })}>{UOMS.map((u) => <option key={u}>{u}</option>)}</select></label>
          <label className="f"><span>Units per carton</span><input value={sku.units_per_carton ?? ''} onChange={(e) => setSku({ ...sku, units_per_carton: e.target.value })} /></label>
          {[['track_batch', 'Track batch / lot'], ['track_expiry', 'Track expiry date']].map(([k, t]) => <label key={k} className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!!sku[k]} onChange={(e) => setSku({ ...sku, [k]: e.target.checked })} />{t}</label>)}
          {sku.id && <label className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}><input type="checkbox" style={{ width: 'auto' }} checked={sku.is_active !== false}
            onChange={(e) => setSku({ ...sku, is_active: e.target.checked })} />Active</label>}
        </div>
        <div className="actions"><button className="btn" onClick={() => setSku(null)}>Cancel</button>
          <button className="btn primary" onClick={async () => { if (await send({ action: 'sku', ...sku }, 'SKU saved')) setSku(null); }}>Save</button></div>
      </div></div>}
    </div>
  );
}
