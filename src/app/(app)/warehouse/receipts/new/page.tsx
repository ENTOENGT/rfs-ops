'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/components/api';
import { useMe } from '@/components/Shell';
import { WhTabs, useSkus, useWhConfig } from '@/components/WarehouseShared';

export default function NewReceipt() {
  const { lk } = useMe();
  const router = useRouter();
  const { cfg } = useWhConfig();
  const [f, setF] = useState<any>({ warehouse_id: '', customer_id: '' });
  const [lines, setLines] = useState<{ sku_id: string; expected_qty: string }[]>([{ sku_id: '', expected_qty: '' }]);
  const [err, setErr] = useState('');
  const skus = useSkus(f.customer_id);
  useEffect(() => { if (cfg && !f.warehouse_id && cfg.warehouses[0]) setF((x: any) => ({ ...x, warehouse_id: cfg.warehouses[0].id })); }, [cfg]);
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const save = async () => {
    setErr('');
    try { const g = await api('/api/warehouse/receipts', { body: { ...f, lines: lines.filter((l) => l.sku_id) } }); router.push(`/warehouse/receipts/${g.id}`); }
    catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="page">
      <div className="page-head"><h1>New goods receipt</h1></div>
      <WhTabs />
      {err && <div className="msg err">{err}</div>}
      <div className="panel"><h2>Arrival</h2><div className="grid g3">
        <label className="f"><span>Warehouse <em>*</em></span><select value={f.warehouse_id} onChange={set('warehouse_id')}>
          {cfg?.warehouses.filter((w: any) => w.is_active).map((w: any) => <option key={w.id} value={w.id}>{w.code} — {w.name}</option>)}</select></label>
        <label className="f"><span>Customer (owner of the goods) <em>*</em></span><select value={f.customer_id} onChange={(e) => { setF({ ...f, customer_id: e.target.value }); setLines([{ sku_id: '', expected_qty: '' }]); }}>
          <option value="">Choose customer</option>{lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
        <label className="f"><span>Job No. (if it came on a Job File)</span><input value={f.job_no ?? ''} onChange={set('job_no')} /></label>
        <label className="f"><span>Supplier</span><input value={f.supplier ?? ''} onChange={set('supplier')} /></label>
        <label className="f"><span>Reference (ASN, delivery note, container)</span><input value={f.reference ?? ''} onChange={set('reference')} /></label>
        <label className="f"><span>Expected date</span><input type="date" value={f.expected_date ?? ''} onChange={set('expected_date')} /></label>
      </div></div>
      <div className="panel"><h2>Expected goods</h2>
        {!f.customer_id && <p className="muted small">Choose the customer first — only their SKUs can be received for them.</p>}
        {f.customer_id && skus.length === 0 && <p className="muted small">This customer has no SKUs yet. Add them in Warehouse → Setup.</p>}
        {lines.map((l, i) => <div key={i} style={{ display: 'flex', gap: 8, marginBottom: 6 }}>
          <select style={{ flex: 3 }} value={l.sku_id} onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, sku_id: e.target.value } : x))}>
            <option value="">Choose SKU</option>{skus.map((s) => <option key={s.id} value={s.id}>{s.sku_code} — {s.name} ({s.uom})</option>)}</select>
          <input style={{ flex: 1 }} value={l.expected_qty} placeholder="Qty" inputMode="decimal" onChange={(e) => setLines(lines.map((x, j) => j === i ? { ...x, expected_qty: e.target.value } : x))} />
          <button className="btn small" disabled={lines.length === 1} onClick={() => setLines(lines.filter((_, j) => j !== i))}>✕</button></div>)}
        <button className="btn small" onClick={() => setLines([...lines, { sku_id: '', expected_qty: '' }])}>+ Add SKU</button>
      </div>
      <div className="form-actions"><Link className="btn" href="/warehouse/receipts">Cancel</Link><button className="btn primary" onClick={save}>Save receipt</button></div>
    </div>
  );
}
