'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/components/api';
import { useMe } from '@/components/Shell';
import { WhTabs, useSkus, useWhConfig } from '@/components/WarehouseShared';

export default function NewOrder() {
  const { lk } = useMe();
  const router = useRouter();
  const { cfg } = useWhConfig();
  const [f, setF] = useState<any>({ warehouse_id: '', customer_id: '' });
  const [lines, setLines] = useState<{ sku_id: string; qty: string }[]>([{ sku_id: '', qty: '' }]);
  const [err, setErr] = useState('');
  const skus = useSkus(f.customer_id);
  useEffect(() => { if (cfg && !f.warehouse_id && cfg.warehouses[0]) setF((x: any) => ({ ...x, warehouse_id: cfg.warehouses[0].id })); }, [cfg]);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setErr('');
    try { const o = await api('/api/warehouse/orders', { body: { ...f, lines: lines.filter((l) => l.sku_id) } }); router.push(`/warehouse/orders/${o.id}`); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="page">
      <div className="page-head"><h1>New outbound order</h1></div>
      <WhTabs />
      {err && <div className="msg err">{err}</div>}
      <div className="panel"><h2>Order</h2><div className="grid g3">
        <label className="f"><span>Warehouse <em>*</em></span><select value={f.warehouse_id} onChange={set('warehouse_id')}>
          {cfg?.warehouses.filter((w: any) => w.is_active).map((w: any) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></label>
        <label className="f"><span>Customer (owner of the stock) <em>*</em></span><select value={f.customer_id} onChange={(e) => { setF({ ...f, customer_id: e.target.value }); setLines([{ sku_id: '', qty: '' }]); }}>
          <option value="">Choose customer</option>{lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="f"><span>Customer's order / PO no.</span><input value={f.customer_reference ?? ''} onChange={set('customer_reference')} /></label>
        <label className="f"><span>Ship to <em>*</em></span><input value={f.ship_to_name ?? ''} onChange={set('ship_to_name')} /></label>
        <label className="f"><span>Contact</span><input value={f.ship_to_contact ?? ''} onChange={set('ship_to_contact')} /></label>
        <label className="f"><span>Phone</span><input value={f.ship_to_phone ?? ''} onChange={set('ship_to_phone')} /></label>
        <label className="f span2"><span>Address</span><input value={f.ship_to_address ?? ''} onChange={set('ship_to_address')} /></label>
        <label className="f"><span>Required date</span><input type="date" value={f.required_date ?? ''} onChange={set('required_date')} /></label>
        <label className="f"><span>Job No. (optional)</span><input value={f.job_no ?? ''} onChange={set('job_no')} /></label>
        <label className="f span2"><span>Remarks</span><input value={f.remarks ?? ''} onChange={set('remarks')} /></label>
      </div></div>
      <div className="panel"><h2>Items</h2>
        {!f.customer_id && <p className="muted small">Choose the customer first — only their stock can be sent.</p>}
        {lines.map((l, i) => <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
          <select style={{ flex: 3 }} value={l.sku_id} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, sku_id: e.target.value } : x))}>
            <option value="">Choose SKU</option>{skus.map((s) => <option key={s.id} value={s.id}>{s.sku_code} — {s.name} (in stock: {Number(s.on_hand)})</option>)}</select>
          <input style={{ flex: 1 }} value={l.qty} placeholder="Qty" inputMode="decimal" onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, qty: e.target.value } : x))} />
          <button className="btn small" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button></div>)}
        <button className="btn small" onClick={() => setLines([...lines, { sku_id: '', qty: '' }])}>+ Add item</button>
      </div>
      <div className="form-actions"><Link className="btn" href="/warehouse/orders">Cancel</Link><button className="btn primary" onClick={save}>Save order</button></div>
    </div>
  );
}
