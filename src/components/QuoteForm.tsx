'use client';
import { useMe } from './Shell';
import { routeLabel } from '@/lib/routingRules';
import { fmtMoney } from './api';
import { SERVICE_TYPES, DIRECTIONS, CHARGE_UNITS } from '@/lib/jobfileRules';

const Err = ({ m }: { m?: string }) => (m ? <small className="ferr">{m}</small> : null);
export const emptyLine = () => ({ description: '', charge_unit: 'shipment', quantity: '1', cost_rate: '', sell_rate: '', margin_type: '', margin_value: '' });

/** Same rule as the server: % → selling = cost ÷ (1 − %), so the margin is that % of the selling price; amount → cost + amount. */
export function sellFromMargin(cost: string, type: string, value: string): string {
  const c = Math.round(Number(cost || 0) * 100);
  const v = Number(value || 0);
  if (type === 'amount') return ((c + Math.round(v * 100)) / 100).toFixed(2);
  if (type === 'percent' && v < 100) return (Math.round(c / (1 - v / 100)) / 100).toFixed(2);
  return '';
}

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
/** The message when a rate is not the lowest valid price for the same request, or null. */
export function cheaperThan(rates: any[], r: any): string | null {
  if (!r?.rate_group || r.lowest) return null;
  const best = rates.find((x) => x.rate_group === r.rate_group && x.lowest);
  if (!best || Number(best.quoted_cost) >= Number(r.quoted_cost)) return null;
  return `${best.vendor_name} quoted less for the same request: ${fmtMoney(best.quoted_cost, best.currency)} (${best.request_no}) against ${r.vendor_name} ${fmtMoney(r.quoted_cost, r.currency)}.`;
}

export function QuoteFields({ f, setF, fe = {}, minMargin, vendorRates = [], jobNo, routes = [] }: { f: any; setF: (v: any) => void; fe?: Record<string, string>; minMargin?: number;
  vendorRates?: any[]; jobNo?: string; routes?: any[] }) {
  // Part G2: with several route options every charge says which option it belongs to (a vendor rate brings its own)
  const multi = routes.length > 1;
  const { me, lk } = useMe();
  const { buyingView, sellingView, profitView } = me.financial_access;
  const set = (k: string) => (e: any) => setF({ ...f, [k]: e.target.value });
  const lines: any[] = f.lines ?? [];
  const canMargin = buyingView && sellingView;
  // when a line uses a margin, its selling rate follows the cost and margin as you type
  const setLine = (i: number, k: string, v: string) => setF({ ...f, lines: lines.map((l, j) => {
    if (j !== i) return l;
    const n = { ...l, [k]: v };
    if (n.margin_type && ['cost_rate', 'margin_type', 'margin_value'].includes(k)) n.sell_rate = sellFromMargin(n.cost_rate, n.margin_type, n.margin_value);
    return n;
  }) });
  const t = totals(lines);
  const cur = lk.currency ?? 'AED';
  const rates = vendorRates.filter((r) => r.quoted_cost !== null && r.quoted_cost !== undefined && r.status !== 'cancelled');
  const useRate = (r: any) => {
    const w = cheaperThan(rates, r);
    if (w && !confirm(`${w}\n\nUse ${r.vendor_name}'s rate anyway?`)) return;
    const line = { ...emptyLine(), description: `${r.service === 'rate' ? 'Freight' : r.service} — ${r.vendor_name}`, cost_rate: r.quoted_cost, margin_type: sellingView ? 'percent' : '', margin_value: '',
      sell_rate: '', vendor_request_id: r.id, route_id: r.route_id ?? '' };
    const blank = lines.length === 1 && !lines[0].description && !lines[0].cost_rate && !lines[0].sell_rate;
    setF({ ...f, lines: blank ? [line] : [...lines, line] });
  };
  return <>
    <div className="panel"><h2>Enquiry</h2><div className="grid g3">
      <label className={`f span2${fe.customer_id ? ' bad' : ''}`}><span>Customer <em>*</em></span>
        <select value={f.customer_id ?? ''} onChange={set('customer_id')} disabled={!!f.job_file_id} title={f.job_file_id ? "The Job File's customer" : ''}><option value="">Choose customer</option>
          {lk.customers.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</select><Err m={fe.customer_id} /></label>
      {jobNo && <label className="f"><span>Shipment</span><input value={jobNo} readOnly /></label>}
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
    {buyingView && rates.length > 0 && <div className="panel"><h2>Rates received for {jobNo}</h2>
      <p className="muted small" style={{ marginTop: 0 }}>Press "Use" to add a vendor's rate as a cost line, then put your margin on it.</p>
      <div className="table-wrap"><table className="t"><thead><tr><th>Request</th><th>Vendor</th><th className="num">Rate</th><th>Valid until</th><th /></tr></thead>
        <tbody>{rates.map((r) => { const used = lines.some((l) => l.vendor_request_id === r.id); return <tr key={r.id} className={r.lowest ? 'is-lowest' : ''}>
          <td>{r.request_no}<div className="muted small">{String(r.description ?? '').slice(0, 50)}</div></td>
          <td>{r.vendor_name}{r.lowest && <span className="lowest">Lowest</span>}{multi && r.route_id && <div className="muted small">{routeLabel(routes.find((x: any) => x.id === r.route_id))}</div>}</td><td className="num">{fmtMoney(r.quoted_cost, r.currency)}</td><td>{r.rate_valid_until ?? '—'}</td>
          <td style={{ textAlign: 'right' }}>{used ? <span className="muted small">Used</span> : <button className="btn small" type="button" onClick={() => useRate(r)}>Use</button>}</td></tr>; })}</tbody></table></div>
    </div>}
    <div className="panel"><h2>Charges ({cur}, excluding VAT)</h2>
      <div className="table-wrap"><table className="t">
        <thead><tr><th style={{ width: '32%' }}>Charge</th>{multi && <th>Route option</th>}<th>Charged</th><th className="num">Qty</th>
          {buyingView && <th className="num">Cost rate</th>}{canMargin && <th>Margin</th>}{sellingView && <th className="num">Selling rate</th>}
          {sellingView && <th className="num">Amount</th>}<th /></tr></thead>
        <tbody>{lines.map((l, i) => <tr key={i}>
          <td><input value={l.description} onChange={(e) => setLine(i, 'description', e.target.value)} placeholder="e.g. Ocean freight, THC, DO fee" />
            {l.vendor_request_id && (() => { const r = rates.find((x) => x.id === l.vendor_request_id); const w = r && cheaperThan(rates, r);
              return r ? <div className="small" style={{ marginTop: 3 }}><span className="muted">Vendor rate {r.request_no} · {r.vendor_name}</span>
                {w && <div className="flag" style={{ display: 'block', marginTop: 3, whiteSpace: 'normal' }}>{w}</div>}</div> : null; })()}</td>
          {multi && <td><select value={l.route_id ?? ''} disabled={!!l.vendor_request_id && !!rates.find((x) => x.id === l.vendor_request_id)?.route_id} onChange={(e) => setLine(i, 'route_id', e.target.value)} aria-label="Option">
            <option value="">Option?</option>{routes.map((r: any) => <option key={r.id} value={r.id}>{routeLabel(r)}</option>)}</select></td>}
          <td><select value={l.charge_unit} onChange={(e) => setLine(i, 'charge_unit', e.target.value)}>
            {CHARGE_UNITS.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></td>
          <td className="num"><input style={{ width: 80, textAlign: 'right' }} value={l.quantity} onChange={(e) => setLine(i, 'quantity', e.target.value)} inputMode="decimal" /></td>
          {buyingView && <td className="num"><input style={{ width: 110, textAlign: 'right' }} value={l.cost_rate ?? ''} onChange={(e) => setLine(i, 'cost_rate', e.target.value)} inputMode="decimal" /></td>}
          {canMargin && <td style={{ whiteSpace: 'nowrap' }}>
            <select style={{ width: 92 }} value={l.margin_type ?? ''} onChange={(e) => setLine(i, 'margin_type', e.target.value)} aria-label="Margin type">
              <option value="">Type rate</option><option value="percent">Margin %</option><option value="amount">Margin {cur}</option></select>
            {l.margin_type && <input style={{ width: 80, textAlign: 'right', marginLeft: 4 }} value={l.margin_value ?? ''}
              onChange={(e) => setLine(i, 'margin_value', e.target.value)} inputMode="decimal" placeholder={l.margin_type === 'percent' ? '%' : cur} aria-label="Margin" />}</td>}
          {sellingView && <td className="num"><input style={{ width: 110, textAlign: 'right', background: l.margin_type ? 'var(--line-soft)' : undefined }}
            value={l.sell_rate ?? ''} readOnly={!!l.margin_type} title={l.margin_type ? 'Worked out from cost + margin' : ''}
            onChange={(e) => setLine(i, 'sell_rate', e.target.value)} inputMode="decimal" /></td>}
          {sellingView && <td className="num">{fmtMoney((Math.round(Number(l.quantity || 0) * Math.round(Number(l.sell_rate || 0) * 100)) / 100).toFixed(2), '')}</td>}
          <td><button className="btn small" type="button" disabled={lines.length === 1} onClick={() => setF({ ...f, lines: lines.filter((_, j) => j !== i) })}>✕</button></td>
        </tr>)}</tbody>
      </table></div>
      <button className="btn small" type="button" style={{ marginTop: 8 }} onClick={() => setF({ ...f, lines: [...lines, emptyLine()] })}>+ Add charge</button>
      {canMargin && <p className="muted small" style={{ margin: '8px 0 0' }}>Margin %: the margin is that share of the selling price (cost 1,000 at 20% → selling 1,250). Margin {cur}: added to the cost per unit. The customer copy never shows cost or margin.</p>}
      <dl className="kv" style={{ marginTop: 12 }}>
        {buyingView && <><dt>Total cost</dt><dd>{fmtMoney(t.cost, cur)}</dd></>}
        {sellingView && <><dt>Total to customer</dt><dd><b>{fmtMoney(t.sell, cur)}</b></dd></>}
        {profitView && <><dt>Margin</dt><dd>{fmtMoney(t.margin, cur)}{t.pct !== null && ` (${t.pct}%)`}
          {Number(t.margin) < 0 ? <span className="loss-tag">LOSS — selling below cost</span>
            : minMargin !== undefined && t.pct !== null && Number(t.pct) < minMargin && <span className="flag" style={{ marginLeft: 8 }}>Below {minMargin}% — needs approval</span>}</dd></>}
      </dl>
    </div>
    <div className="panel"><h2>Terms</h2>
      {f.terms_template_name && <p className="muted small" style={{ marginTop: 0 }}>Filled from the template "{f.terms_template_name}". You can change the texts for this quotation only; the template stays as it is.</p>}
      <div className="grid g3">
      <label className="f"><span>Scope of service</span><textarea rows={4} value={f.scope ?? ''} onChange={set('scope')} /></label>
      <label className="f"><span>Exclusions</span><textarea rows={4} value={f.exclusions ?? ''} onChange={set('exclusions')} placeholder="e.g. Duty, VAT, inspection charges, demurrage" /></label>
      <label className="f"><span>Terms and conditions</span><textarea rows={4} value={f.terms ?? ''} onChange={set('terms')} /></label>
      <label className="f"><span>Payment / commercial conditions</span><textarea rows={3} value={f.payment_terms ?? ''} onChange={set('payment_terms')} /></label>
      <label className="f span2"><span>Additional remarks</span><textarea rows={3} value={f.additional_remarks ?? ''} onChange={set('additional_remarks')} /></label>
    </div></div>
  </>;
}
