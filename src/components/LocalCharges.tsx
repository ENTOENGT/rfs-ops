'use client';
import { useEffect, useState } from 'react';
import { api, fmtMoney } from './api';
import { sellFromMargin } from './QuoteForm';

const r2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
const TAG: Record<string, string> = { receipt: 'as per receipt' };

/**
 * 25 Nov (migration 044) — on the quotation, for people who see cost: our local charges (clearance, transport, handling)
 * worked out from the rate card that fits the enquiry (containers 20 / 40 ft, BLs, documents, weight, DG). Shows what was
 * used and what may be missing; nothing is added until "Add to the quotation". Separate lines (section "Local charges"),
 * or inside the all-in price (the breakup kept in the line's staff note). "If applicable" lines stay separate, not in the total.
 */
export function LocalChargesBox({ f, setF, routes, cur }: { f: any; setF: (v: any) => void; routes: any[]; cur: string }) {
  const [d, setD] = useState<any>(null);
  const [p, setP] = useState<any>({});
  const [on, setOn] = useState<Record<string, boolean>>({});
  const [how, setHow] = useState<'lines' | 'all_in'>('lines');
  const [err, setErr] = useState('');
  const [open, setOpen] = useState(false);
  const lines: any[] = f.lines ?? [];
  const allIn = lines.filter((l) => l.rate_mode === 'all_in');
  const calc = async (extra: any = {}) => {
    setErr('');
    try {
      const r = await api('/api/local-charges/calc', { body: { file_id: f.job_file_id || undefined, currency: cur, mode: f.job_file_id ? undefined : f.service_type, direction: f.job_file_id ? undefined : f.direction,
        port: f.job_file_id ? undefined : f.destination, kg: f.job_file_id ? undefined : f.chargeable_weight_kg || f.gross_weight_kg || undefined, ...(extra.fresh ? {} : p), ...extra, fresh: undefined } });
      setD(r); setP({ ...r.params, card_id: r.card?.id ?? '' }); setOn(Object.fromEntries(r.lines.map((l: any) => [l.key, l.include])));
    } catch (e: any) { setErr(e.message); }
  };
  // worked out by itself once, when there are no local charges yet
  useEffect(() => { if (open && (f.job_file_id || f.service_type)) calc({ fresh: true }); }, [open, f.job_file_id]);   // again when the enquiry has loaded
  useEffect(() => { if (!lines.some((l) => l.section === 'local')) setOpen(true); }, []);
  if (!open) return <button type="button" className="btn small" onClick={() => setOpen(true)}>Local charges (clearance / transport)…</button>;

  const picked = (d?.lines ?? []).filter((l: any) => on[l.key]);
  const note = d?.card ? `From the card "${d.card.name}" (version ${d.card.version})` : '';
  const add = () => {
    if (!picked.length) return setErr('Tick at least one charge');
    const toLine = (l: any, route_id: string) => ({ description: l.description, charge_unit: l.charge_unit, quantity: l.quantity, cost_rate: l.cost_rate,
      sell_rate: l.sell_rate, margin_type: '', margin_value: '', route_id, section: 'local', optional: !!l.optional, note: l.note ?? '', internal_note: `${note}: ${l.how}` });
    const targets = routes.length > 1 ? routes.map((r: any) => r.id) : [''];
    let out = [...lines];
    if (how === 'all_in' && allIn.length) {
      // the passed-on costs (and our own selling charges) go into each all-in line; "if applicable" lines stay separate
      const inside = picked.filter((l: any) => !l.optional), sep = picked.filter((l: any) => l.optional);
      const cost = inside.reduce((t: number, l: any) => t + Number(l.quantity) * Number(l.cost_rate), 0);
      const sell = inside.reduce((t: number, l: any) => t + Number(l.quantity) * Number(l.sell_rate), 0);
      const breakup = inside.map((l: any) => `${l.description}: ${l.how}${l.sell_only ? ' (our selling charge)' : ''}`).join('; ');
      out = out.map((l) => {
        if (l.rate_mode !== 'all_in' || (routes.length > 1 && !targets.includes(l.route_id))) return l;
        const qn = Number(l.quantity || 1);
        const oldSell = Number(l.margin_type && String(l.margin_value ?? '') !== '' ? sellFromMargin(l.cost_rate, l.margin_type, l.margin_value) : l.sell_rate || 0) || Number(l.cost_rate || 0);
        const nc = Number(l.cost_rate || 0) + cost / qn, ns = oldSell + sell / qn;
        return { ...l, description: /clearance|local/i.test(l.description) ? l.description : `${l.description.replace(/\s*\(all-in\)\s*$/i, '')}, clearance and delivery (all-in)`,
          cost_rate: r2(nc), cost_original: null, cost_currency: null, cost_fx: null,
          margin_type: 'amount', margin_value: r2(ns - nc), sell_rate: r2(ns),
          internal_note: [l.internal_note, `Includes local charges ${note}: ${breakup}`].filter(Boolean).join('\n') };
      });
      for (const rid of targets) out.push(...sep.map((l: any) => toLine(l, rid)));
    } else {
      for (const rid of targets) out.push(...picked.map((l: any) => toLine(l, rid)));
    }
    const blank = out.length > 1 && !out[0].description && !out[0].cost_rate && !out[0].sell_rate;
    setF({ ...f, lines: blank ? out.slice(1) : out }); setOpen(false);
  };
  const num = (k: string, label: string, w = 70) => <label className="f" style={{ maxWidth: w + 60 }}><span>{label}</span>
    <input value={p[k] ?? ''} inputMode="decimal" style={{ width: w }} onChange={(e) => setP({ ...p, [k]: e.target.value })} /></label>;
  return (
    <div className="conv-box" style={{ marginTop: 10 }} role="region" aria-label="Local charges">
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}><b className="small">Local charges — clearance, transport and handling (our cost)</b><span className="spacer" />
        <button type="button" className="linkish small" onClick={() => setOpen(false)}>Close</button></div>
      {err && <div className="msg err small">{err}</div>}
      {!d && !err && <p className="small muted">Working out…</p>}
      {d && <>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'end', margin: '6px 0' }}>
          <label className="f" style={{ minWidth: 240 }}><span>Rate card</span><select value={p.card_id ?? ''} onChange={(e) => calc({ card_id: e.target.value || undefined })}>
            <option value="">{d.choices.length ? 'Choose a card' : 'No card for this mode'}</option>
            {d.choices.map((c: any) => <option key={c.id} value={c.id}>{c.name}{c.fits ? '' : ' (does not match)'}</option>)}</select></label>
          {f.service_type !== 'air' && d.params.mode !== 'air' ? <>{num('n20', '20 ft')}{num('n40', '40 ft')}</> : num('kg', 'Weight (kg)', 90)}
          {num('bls', 'BLs / AWBs')}{num('docs', 'Documents')}
          <label className="f" style={{ maxWidth: 120 }}><span>DG</span><select value={p.dg === true ? 'yes' : p.dg === false ? 'no' : ''} onChange={(e) => setP({ ...p, dg: e.target.value === 'yes' ? true : e.target.value === 'no' ? false : null })}>
            <option value="">Not known</option><option value="no">No</option><option value="yes">Yes</option></select></label>
          <button type="button" className="btn small" onClick={() => calc({ card_id: p.card_id || undefined })}>Work out again</button>
        </div>
        {d.card && <p className="small muted" style={{ margin: '2px 0 6px' }}>{note}{d.card.notes ? ` — ${d.card.notes}` : ''}</p>}
        {d.lines.length > 0 && <div className="table-wrap"><table className="t compact">
          <thead><tr><th>Add</th><th>Charge</th><th>How it is worked out</th><th className="num">Qty</th><th className="num">Cost</th><th className="num">Amount</th></tr></thead>
          <tbody>{d.lines.map((l: any) => <tr key={l.key} style={{ opacity: on[l.key] ? 1 : 0.6 }}>
            <td><input type="checkbox" style={{ width: 'auto' }} checked={!!on[l.key]} onChange={(e) => setOn({ ...on, [l.key]: e.target.checked })} aria-label={`Add ${l.description}`} /></td>
            <td>{l.description}{l.optional && <span className="badge" style={{ marginLeft: 6, background: '#6B7280' }}>If applicable</span>}
              {l.sell_only && <span className="badge" style={{ marginLeft: 6, background: '#2B6CB0' }}>Our selling charge</span>}
              {l.note && <div className="muted small">{l.note}</div>}</td>
            <td className="small muted">{l.how}</td><td className="num">{Number(l.quantity)}</td>
            <td className="num">{l.sell_only ? '—' : fmtMoney(l.cost_rate, '')}</td><td className="num">{fmtMoney(l.amount, d.currency)}</td></tr>)}</tbody></table></div>}
        {d.missing.length > 0 && <div className="small" style={{ margin: '8px 0', color: '#B7791F' }}><b>Check:</b><ul style={{ margin: '2px 0 0 18px', padding: 0 }}>{d.missing.map((m: string, i: number) => <li key={i}>{m}</li>)}</ul></div>}
        {d.lines.length > 0 && <>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', margin: '6px 0' }}>
            <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="radio" style={{ width: 'auto' }} checked={how === 'lines'} onChange={() => setHow('lines')} />
              As separate lines (under "Local charges"){routes.length > 1 ? ' — on every option' : ''}</label>
            <label className="small" style={{ display: 'flex', gap: 6, alignItems: 'center' }}><input type="radio" style={{ width: 'auto' }} disabled={!allIn.length} checked={how === 'all_in'} onChange={() => setHow('all_in')} />
              Inside the all-in price (one figure for the customer){!allIn.length && ' — use a vendor rate as all-in first'}</label>
          </div>
          <p className="muted small" style={{ margin: '2px 0 6px' }}>Selling = cost (passed on); put your margin on the lines after. "If applicable" lines are shown to the customer but not counted in the total. What was added stays in each line's staff note.</p>
          <button type="button" className="btn small primary" onClick={add}>Add to the quotation</button>
        </>}
      </>}
    </div>
  );
}
