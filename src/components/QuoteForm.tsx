'use client';
import { useMe } from './Shell';
import { fmtMoney } from './api';
import { SERVICE_TYPES, DIRECTIONS, CHARGE_UNITS } from '@/lib/jobfileRules';

const Err = ({ m }: { m?: string }) => (m ? <small className="ferr">{m}</small> : null);
export const emptyLine = () => ({ description: '', charge_unit: 'shipment', quantity: '1', cost_rate: '', sell_rate: '' });

/** Same sums as the server (to the fils), so what you see while typing is what gets saved. */
function totals(lines: any[]) {
  const f = (v: string) => Math.round(Number(v || 0) * 100);
  let cost = 0, sell = 0;
  for (const l of lines) { const qn = Number(l.quantity || 0); cost += Math.round(qn * f(l.cost_rate)); sell += Math.round(qn * f(l.sell_rate)); }
  return { cost: (cost / 100).toFixed(2), sell: (sell / 100).toFixed(2), margin: ((sell - cost) / 100).toFixed(2), pct: sell > 0 ? (((sell - cost) / sell) * 100).toFixed(2) : null };
}

/**
 * Quotation header + charge lines. Cost columns only for people who see cost, selling only for people who
 * see selling — the server enforces the same and keeps hidden values when lines are saved.
 */
export function QuoteFields({ f, setF, fe = {}, minMargin }: { f: any; setF: (v: any) => void; fe?: Record<string, string>; minMargin?: number }) {
  const { me, lk } = useMe();
  const { buyingView, sellingView, profitView } = me.financial_access;
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const lines: any[] = f.lines ?? [];
  const setLine = (i: number, k: string, v: string) => setF({ ...f, lines: lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) });
  const t = totals(lines);
  const cur = lk.currency ?? 'AED';
  return <>
    <div className="panel"><h2>Enquiry</h2><div className="grid g3">
      <label className={`f span2${fe.customer_id ? ' bad' : ''}`}><span>Customer <em>*</em></span>
        <select value={f.customer_id ?? ''} onChange={set('customer_id')}><option value="">Choose customer</option>
          {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select><Err m={fe.customer_id} /></label>
      <label className="f"><span>Enquiry / customer ref.</span><input value={f.enquiry_reference ?? ''} onChange={set('enquiry_reference')} /></label>
      <label className={`f${fe.service_type ? ' bad' : ''}`}><span>Service <em>*</em></span>
        <select value={f.service_type ?? ''} onChange={set('service_type')}><option value="">Choose</option>
          {SERVICE_TYPES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select><Err m={fe.service_type} /></label>
      <label className="f"><span>Direction</span><select value={f.direction ?? 'import'} onChange={set('direction')}>
        {DIRECTIONS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>
      <label className="f"><span>Rates valid until</span><input type="date" value={f.valid_until ?? ''} onChange={set('valid_until')} /></label>
      <label className="f"><span>From</span><input value={f.origin ?? ''} onChange={set('origin')} /></label>
      <label className="f"><span>To</span><input value={f.destination ?? ''} onChange={set('destination')} /></label>
      <label className="f"><span>Packages</span><input type="number" min={0} value={f.packages ?? ''} onChange={set('packages')} /></label>
      <label className="f"><span>Gross weight (kg)</span><input type="number" min={0} value={f.gross_weight_kg ?? ''} onChange={set('gross_weight_kg')} /></label>
      <label className="f"><span>Volume (CBM)</span><input type="number" min={0} step="0.001" value={f.volume_cbm ?? ''} onChange={set('volume_cbm')} /></label>
      <label className="f"><span>Chargeable weight (kg)</span><input type="number" min={0} value={f.chargeable_weight_kg ?? ''} onChange={set('chargeable_weight_kg')} /></label>
      <label className="f span2"><span>Cargo</span><input value={f.cargo_description ?? ''} onChange={set('cargo_description')} /></label>
    </div></div>
    <div className="panel"><h2>Charges ({cur}, excluding VAT)</h2>
      <div className="table-wrap"><table className="t">
        <thead><tr><th style={{ width: '32%' }}>Charge</th><th>Charged</th><th className="num">Qty</th>
          {buyingView && <th className="num">Cost rate</th>}{sellingView && <th className="num">Selling rate</th>}
          {sellingView && <th className="num">Amount</th>}<th /></tr></thead>
        <tbody>{lines.map((l, i) => <tr key={i}>
          <td><input value={l.description} onChange={(e) => setLine(i, 'description', e.target.value)} placeholder="e.g. Ocean freight, THC, DO fee" /></td>
          <td><select value={l.charge_unit} onChange={(e) => setLine(i, 'charge_unit', e.target.value)}>
            {CHARGE_UNITS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></td>
          <td className="num"><input style={{ width: 80, textAlign: 'right' }} value={l.quantity} onChange={(e) => setLine(i, 'quantity', e.target.value)} inputMode="decimal" /></td>
          {buyingView && <td className="num"><input style={{ width: 110, textAlign: 'right' }} value={l.cost_rate ?? ''} onChange={(e) => setLine(i, 'cost_rate', e.target.value)} inputMode="decimal" /></td>}
          {sellingView && <td className="num"><input style={{ width: 110, textAlign: 'right' }} value={l.sell_rate ?? ''} onChange={(e) => setLine(i, 'sell_rate', e.target.value)} inputMode="decimal" /></td>}
          {sellingView && <td className="num">{fmtMoney((Math.round(Number(l.quantity || 0) * Math.round(Number(l.sell_rate || 0) * 100)) / 100).toFixed(2), '')}</td>}
          <td><button className="btn small" type="button" disabled={lines.length === 1} onClick={() => setF({ ...f, lines: lines.filter((_, j) => j !== i) })}>✕</button></td>
        </tr>)}</tbody>
      </table></div>
      <button className="btn small" type="button" style={{ marginTop: 8 }} onClick={() => setF({ ...f, lines: [...lines, emptyLine()] })}>+ Add charge</button>
      <dl className="kv" style={{ marginTop: 12 }}>
        {buyingView && <><dt>Total cost</dt><dd>{fmtMoney(t.cost, cur)}</dd></>}
        {sellingView && <><dt>Total to customer</dt><dd><b>{fmtMoney(t.sell, cur)}</b></dd></>}
        {profitView && <><dt>Margin</dt><dd>{fmtMoney(t.margin, cur)}{t.pct !== null && ` (${t.pct}%)`}
          {minMargin !== undefined && t.pct !== null && Number(t.pct) < minMargin && <span className="flag" style={{ marginLeft: 8 }}>Below {minMargin}% — needs approval</span>}</dd></>}
      </dl>
    </div>
    <div className="panel"><h2>Terms</h2><div className="grid g3">
      <label className="f"><span>Scope of service</span><textarea rows={3} value={f.scope ?? ''} onChange={set('scope')} /></label>
      <label className="f"><span>Exclusions</span><textarea rows={3} value={f.exclusions ?? ''} onChange={set('exclusions')} placeholder="e.g. Duty, VAT, inspection charges, demurrage" /></label>
      <label className="f"><span>Terms and conditions</span><textarea rows={3} value={f.terms ?? ''} onChange={set('terms')} /></label>
    </div></div>
  </>;
}
