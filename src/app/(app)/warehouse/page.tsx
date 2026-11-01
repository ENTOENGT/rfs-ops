'use client';
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime } from '@/components/api';
import { useMe } from '@/components/Shell';
import { COND, WhTabs, qtyFmt, useWhConfig } from '@/components/WarehouseShared';

/** Stock on hand: every bin / SKU / batch, with move, condition change and count adjustment. */
export default function Stock() {
  const { lk } = useMe();
  const { cfg } = useWhConfig();
  const [f, setF] = useState<Record<string, string>>({});
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const [mv, setMv] = useState<any>(null);
  const [adj, setAdj] = useState<any>(null);
  const [led, setLed] = useState<any>(null);
  const load = () => api(`/api/warehouse?${new URLSearchParams(Object.entries(f).filter(([, v]) => v))}`).then((x) => { setD(x); setErr(''); }).catch((e) => setErr(e.message));
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [f]);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const send = async (body: any, done: string) => {
    setErr(''); setOk('');
    try { await api('/api/warehouse', { body }); setMv(null); setAdj(null); setOk(done); load(); } catch (e: any) { setErr(e.message); }
  };
  const bins = (whId: string) => cfg?.locations.filter((l: any) => l.warehouse_id === whId && l.is_active) ?? [];
  return (
    <div className="page">
      <div className="page-head"><h1>Warehouse</h1></div>
      <WhTabs />
      <div className="panel" style={{ marginBottom: 12 }}><div className="grid g4">
        <label className="f"><span>Search</span><input value={f.q ?? ''} onChange={set('q')} placeholder="SKU, product, batch, bin, barcode…" /></label>
        <label className="f"><span>Customer</span><select value={f.customer_id ?? ''} onChange={set('customer_id')}><option value="">All</option>
          {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="f"><span>Warehouse</span><select value={f.warehouse_id ?? ''} onChange={set('warehouse_id')}><option value="">All</option>
          {cfg?.warehouses.map((w: any) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></label>
        <label className="f"><span>Condition</span><select value={f.condition ?? ''} onChange={set('condition')}><option value="">All</option>
          {Object.entries(COND).map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>
        <label className="f"><span>Expiring within (days)</span><input type="number" min={0} value={f.expiring_days ?? ''} onChange={set('expiring_days')} /></label>
      </div></div>
      {err && <div className="msg err">{err}</div>}
      {ok && <div className="msg ok">{ok}</div>}
      <div className="panel flush"><div className="table-wrap"><table className="t">
        <thead><tr><th>Customer</th><th>SKU</th><th>Bin</th><th>Batch</th><th>Expiry</th><th>Condition</th>
          <th className="num">On hand</th><th className="num">Reserved</th><th className="num">Available</th><th /></tr></thead>
        <tbody>
          {d?.rows.map((r: any) => <tr key={r.id}>
            <td>{r.customer_name}</td>
            <td><b>{r.sku_code}</b><div className="muted small">{r.sku_name} · {r.uom}</div></td>
            <td>{r.warehouse_code} · {r.location_code}</td><td>{r.batch_no || '—'}</td>
            <td>{fmtDate(r.expiry_date)}{r.expired && <div className="flag">Expired</div>}</td>
            <td>{r.condition === 'good' ? 'Good' : <span className="flag">{COND[r.condition]}</span>}</td>
            <td className="num">{qtyFmt(r.qty_on_hand)}</td><td className="num">{Number(r.qty_reserved) ? qtyFmt(r.qty_reserved) : '—'}</td>
            <td className="num"><b>{qtyFmt(r.qty_available)}</b></td>
            <td style={{ whiteSpace: 'nowrap', textAlign: 'right' }}>
              {(d.can.move || d.can.adjust) && <button className="btn small" onClick={() => setMv({ row: r, qty: String(Number(r.qty_available)), to_location_id: '', to_condition: r.condition, reason: '' })}>Move</button>}{' '}
              {d.can.adjust && <button className="btn small" onClick={() => setAdj({ row: r, counted_qty: String(Number(r.qty_on_hand)), reason: '' })}>Count</button>}{' '}
              <button className="btn small" onClick={() => api(`/api/warehouse?view=ledger&sku_id=${r.sku_id}&location_id=${r.location_id}`).then((x) => setLed({ row: r, rows: x }))}>History</button>
            </td></tr>)}
          {d && d.rows.length === 0 && <tr><td colSpan={10} className="muted" style={{ padding: 24, textAlign: 'center' }}>No stock here.</td></tr>}
        </tbody></table></div>
        <div className="pager"><span>{d ? `${d.rows.length} stock line${d.rows.length === 1 ? '' : 's'}` : 'Loading…'}</span></div></div>

      {mv && <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setMv(null)}><div className="modal" role="dialog" aria-label="Move stock">
        <h2>Move {mv.row.sku_code} from {mv.row.location_code}</h2>
        <p className="small muted">{qtyFmt(mv.row.qty_available)} can move{Number(mv.row.qty_reserved) > 0 && ` (${qtyFmt(mv.row.qty_reserved)} is reserved for orders and stays)`}.</p>
        <div className="grid g2">
          <label className="f"><span>Quantity</span><input value={mv.qty} onChange={(e) => setMv({ ...mv, qty: e.target.value })} inputMode="decimal" /></label>
          <label className="f"><span>To bin</span><select value={mv.to_location_id} onChange={(e) => setMv({ ...mv, to_location_id: e.target.value })}>
            <option value="">Same bin</option>{bins(mv.row.warehouse_id).filter((l: any) => l.id !== mv.row.location_id).map((l: any) =>
              <option key={l.id} value={l.id}>{l.code}{l.location_type !== 'storage' ? ` (${l.location_type})` : ''}</option>)}</select></label>
          {d.can.adjust && <label className="f"><span>Condition</span><select value={mv.to_condition} onChange={(e) => setMv({ ...mv, to_condition: e.target.value })}>
            {Object.entries(COND).map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>}
          <label className="f"><span>Reason {mv.to_condition !== mv.row.condition && <em>*</em>}</span><input value={mv.reason} onChange={(e) => setMv({ ...mv, reason: e.target.value })} /></label>
        </div>
        <div className="actions"><button className="btn" onClick={() => setMv(null)}>Cancel</button>
          <button className="btn primary" onClick={() => send({ action: 'move', balance_id: mv.row.id, qty: mv.qty, to_location_id: mv.to_location_id || undefined,
            to_condition: mv.to_condition, reason: mv.reason }, 'Stock moved')}>Move</button></div>
      </div></div>}

      {adj && <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setAdj(null)}><div className="modal" role="dialog" aria-label="Stock count">
        <h2>Count {adj.row.sku_code} in {adj.row.location_code}</h2>
        <p className="small muted">System: {qtyFmt(adj.row.qty_on_hand)}. Enter what is physically there; the difference is written to the ledger with your name and reason.</p>
        <div className="grid g2">
          <label className="f"><span>Counted quantity</span><input value={adj.counted_qty} onChange={(e) => setAdj({ ...adj, counted_qty: e.target.value })} inputMode="decimal" /></label>
          <label className="f"><span>Reason <em>*</em></span><input value={adj.reason} onChange={(e) => setAdj({ ...adj, reason: e.target.value })} placeholder="Cycle count, found, lost…" /></label>
        </div>
        <div className="actions"><button className="btn" onClick={() => setAdj(null)}>Cancel</button>
          <button className="btn primary" onClick={() => send({ action: 'adjust', balance_id: adj.row.id, counted_qty: adj.counted_qty, reason: adj.reason }, 'Stock adjusted')}>Save count</button></div>
      </div></div>}

      {led && <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setLed(null)}><div className="modal" role="dialog" aria-label="Stock history" style={{ maxWidth: 820 }}>
        <h2>{led.row.sku_code} in {led.row.location_code} — history</h2>
        <div className="table-wrap"><table className="t"><thead><tr><th>When</th><th>Movement</th><th>Batch</th><th className="num">Qty</th><th className="num">Balance</th><th>Ref.</th><th>By</th></tr></thead>
          <tbody>{led.rows.map((t: any) => <tr key={t.id}><td>{fmtDateTime(t.at)}</td><td>{t.kind.replace('_', ' ')}{t.reason && <div className="muted small">{t.reason}</div>}</td>
            <td>{t.batch_no || '—'}</td><td className="num">{Number(t.qty_change) > 0 ? '+' : ''}{qtyFmt(t.qty_change)}</td><td className="num">{qtyFmt(t.balance_after)}</td>
            <td>{t.reference}</td><td>{t.user_name}</td></tr>)}</tbody></table></div>
        <div className="actions"><button className="btn" onClick={() => setLed(null)}>Close</button></div>
      </div></div>}
    </div>
  );
}
