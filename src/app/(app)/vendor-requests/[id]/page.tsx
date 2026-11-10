'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime, fmtMoney } from '@/components/api';
import { NewVendorRequest } from '@/components/NewVendorRequest';
import { EmailButton } from '@/components/EmailButton';
import { useMe } from '@/components/Shell';
import { CHARGE_SECTIONS, RATE_SOURCES } from '@/lib/commercialRules';
import { CURRENCIES, CURRENCY_CODES, fxRate } from '@/lib/currency';

const LABEL: Record<string, string> = { quoted: 'Rate received', confirmed: 'Confirmed', in_progress: 'In progress', completed: 'Completed', disputed: 'Problem / dispute', cancelled: 'Cancel', revise: 'Revised rate' };
const blankCharge = (cur: string) => ({ section: 'freight', description: '', basis: '', quantity: '1', amount: '', currency: cur, exchange_rate: '1' });

/** Full rate entry: charge lines (freight, origin, destination) or one total, and the terms that come with the rate. */
function RateFields({ s, set, d }: { s: any; set: (v: any) => void; d: any }) {
  const { lk } = useMe();
  const charges: any[] = s.charges ?? [];
  const total = charges.reduce((t, c) => t + (Number(c.amount) || 0) * (Number(c.quantity) || 0) * (Number(c.exchange_rate) || 0), 0);
  const setCh = (i: number, k: string, v: string) => set({ ...s, charges: charges.map((c, j) => j === i ? { ...c, [k]: v } : c) });
  return <>
    <div className="grid g4">
      <label className="f"><span>Rate source</span><select value={s.rate_source ?? ''} onChange={(e) => set({ ...s, rate_source: e.target.value })}>
        {RATE_SOURCES.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></label>
      <label className="f"><span>Currency of the rate</span><select value={s.currency} onChange={(e) => set({ ...s, currency: e.target.value,
        charges: (s.charges ?? []).map((c: any) => ({ ...c, exchange_rate: String(fxRate(c.currency, e.target.value, lk.fx ?? {}) ?? c.exchange_rate) })) })}>
        {CURRENCIES.map(([c, n]) => <option key={c} value={c}>{c} — {n}</option>)}</select></label>
      <label className="f"><span>Vendor reference</span><input value={s.vendor_reference} onChange={(e) => set({ ...s, vendor_reference: e.target.value })} /></label>
      <label className="f"><span>Valid until</span><input type="date" value={s.rate_valid_until} onChange={(e) => set({ ...s, rate_valid_until: e.target.value })} /></label>
      <label className="f"><span>Line / airline</span><input value={s.carrier} onChange={(e) => set({ ...s, carrier: e.target.value })} /></label>
      <label className="f"><span>Transit time (days)</span><input inputMode="numeric" value={s.transit_days} onChange={(e) => set({ ...s, transit_days: e.target.value })} /></label>
      <label className="f"><span>Free days</span><input inputMode="numeric" value={s.free_days} onChange={(e) => set({ ...s, free_days: e.target.value })} /></label>
      <label className="f"><span>Sailing / flight (ETD)</span><input type="date" value={s.etd} onChange={(e) => set({ ...s, etd: e.target.value })} /></label>
      <label className="f span2"><span>Routing</span><input value={s.routing} onChange={(e) => set({ ...s, routing: e.target.value })} placeholder="e.g. Shanghai – Jebel Ali direct" /></label>
      <label className="f span2"><span>Included</span><input value={s.inclusions} onChange={(e) => set({ ...s, inclusions: e.target.value })} /></label>
      <label className="f span4"><span>Not included</span><input value={s.exclusions} onChange={(e) => set({ ...s, exclusions: e.target.value })} /></label>
    </div>
    <h3 className="small" style={{ margin: '10px 0 6px' }}>Charges</h3>
    {charges.length === 0 ? <label className="f" style={{ maxWidth: 260 }}><span>Total rate ({s.currency || d.currency})</span>
      <input inputMode="decimal" value={s.quoted_cost} onChange={(e) => set({ ...s, quoted_cost: e.target.value })} /></label>
      : <div className="table-wrap"><table className="t"><thead><tr><th>Part</th><th>Charge</th><th>Basis</th><th className="num">Qty</th><th className="num">Amount</th><th>Currency</th><th className="num">Rate to {s.currency || d.currency}</th><th /></tr></thead>
        <tbody>{charges.map((c, i) => <tr key={i}>
          <td><select value={c.section} onChange={(e) => setCh(i, 'section', e.target.value)}>{CHARGE_SECTIONS.map(([k, n]) => <option key={k} value={k}>{n}</option>)}</select></td>
          <td><input value={c.description} onChange={(e) => setCh(i, 'description', e.target.value)} placeholder="e.g. Ocean freight, THC" /></td>
          <td><input value={c.basis} onChange={(e) => setCh(i, 'basis', e.target.value)} placeholder="per container" style={{ width: 120 }} /></td>
          <td><input value={c.quantity} onChange={(e) => setCh(i, 'quantity', e.target.value)} style={{ width: 60 }} inputMode="decimal" /></td>
          <td><input value={c.amount} onChange={(e) => setCh(i, 'amount', e.target.value)} style={{ width: 100 }} inputMode="decimal" /></td>
          <td><select value={c.currency} style={{ width: 86 }} aria-label="Currency" onChange={(e) => { const x = fxRate(e.target.value, s.currency || d.currency, lk.fx ?? {});
            set({ ...s, charges: charges.map((y: any, j: number) => j === i ? { ...y, currency: e.target.value, exchange_rate: x ? String(x) : y.exchange_rate } : y) }); }}>
            {CURRENCY_CODES.map((c) => <option key={c}>{c}</option>)}</select></td>
          <td><input value={c.exchange_rate} onChange={(e) => setCh(i, 'exchange_rate', e.target.value)} style={{ width: 80 }} inputMode="decimal" /></td>
          <td><button className="btn small" type="button" onClick={() => set({ ...s, charges: charges.filter((_, j) => j !== i) })}>✕</button></td></tr>)}</tbody>
        <tfoot><tr><td colSpan={4}><b>Total</b></td><td className="num"><b>{total.toFixed(2)}</b></td><td colSpan={3}>{s.currency || d.currency}</td></tr></tfoot></table></div>}
    <button className="btn small" type="button" onClick={() => set({ ...s, charges: [...charges, blankCharge(s.currency || d.currency)] })}>
      {charges.length ? '+ Add charge' : 'Enter it charge by charge instead'}</button>
  </>;
}

export default function VendorRequest({ params }: { params: { id: string } }) {
  const [d, setD] = useState<any>(null);
  const [step, setStep] = useState<any>(null);
  const [note, setNote] = useState('');
  const [err, setErr] = useState('');
  const [more, setMore] = useState(false);
  const load = () => api(`/api/vendor-requests/${params.id}`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [params.id]);  // eslint-disable-line react-hooks/exhaustive-deps
  const act = async (body: any) => { setErr(''); try { await api(`/api/vendor-requests/${params.id}`, { body }); await load(); setStep(null); return true; } catch (e: any) { setErr(e.message); window.scrollTo(0, 0); return false; } };
  if (!d) return <div className="page">{err ? <div className="msg err">{err}</div> : <p className="muted">Loading…</p>}</div>;
  const rateEntry = (status: string) => ({ status, vendor_reference: d.vendor_reference ?? '', quoted_cost: d.quoted_cost ?? '', rate_valid_until: d.rate_valid_until ?? '',
    currency: d.currency, rate_source: d.rate_source ?? 'other', carrier: d.carrier ?? '', transit_days: d.transit_days ?? '', free_days: d.free_days ?? '', etd: d.etd ?? '',
    routing: d.routing ?? '', inclusions: d.inclusions ?? '', exclusions: d.exclusions ?? '', note: '',
    charges: (d.charges ?? []).map((c: any) => ({ ...c, quantity: String(Number(c.quantity)), exchange_rate: String(Number(c.exchange_rate)) })) });
  const isRate = d.service === 'rate';
  const save = () => {
    const s = { ...step };
    if (!d.can.cost) { delete s.quoted_cost; delete s.charges; }
    if (s.charges && s.charges.length === 0) delete s.charges;
    if (s.status === 'revise') { const { status, ...rest } = s; return act({ ...rest, what: 'revise_rate' }); }
    return act(s);
  };
  const ref = d.job_no ?? d.shipping_ref ?? d.enquiry_ref;
  return (
    <div className="page">
      <div className="page-head"><h1>{d.request_no}</h1><span className="badge" style={{ background: d.status_color }}>{d.status_name}</span>
        {d.rate_version > 1 && <span className="muted small">version {d.rate_version}</span>}<span className="spacer" />
        {d.can.update && d.next.map((s: string) => <button key={s} className={`btn${s === 'cancelled' ? ' danger' : s === 'completed' ? ' primary' : ''}`}
          onClick={() => setStep(s === 'quoted' || (s === 'confirmed' && isRate) ? rateEntry(s) : { status: s, vendor_reference: d.vendor_reference ?? '', note: '' })}>{LABEL[s]}</button>)}
        {d.can.revise && <button className="btn" onClick={() => setStep(rateEntry('revise'))}>Revised rate</button>}
        {d.can.update && isRate && d.job_file_id && ['requested', 'quoted'].includes(d.status) && <button className="btn" onClick={() => setMore(true)}>Ask more vendors</button>}
        {d.can.update && <EmailButton kind="vendor_request" id={d.id} label="Email vendor" onLogged={load} />}</div>
      {d.cheaper_warning && <div className="msg warn"><b>Another vendor gave a lower price.</b> {d.cheaper_warning}</div>}
      {err && <div className="msg err">{err}</div>}
      {step && <div className="panel"><h2>{LABEL[step.status]}</h2>
        {(['quoted', 'revise'].includes(step.status) || (step.status === 'confirmed' && isRate)) && d.can.cost ? <RateFields s={step} set={setStep} d={d} />
          : <div className="grid g3">
            {['quoted', 'confirmed'].includes(step.status) && <label className="f"><span>Vendor reference (quote / booking no.)</span><input value={step.vendor_reference} onChange={(e) => setStep({ ...step, vendor_reference: e.target.value })} /></label>}
          </div>}
        {['completed', 'disputed', 'cancelled', 'revise'].includes(step.status) && <label className="f"><span>{step.status === 'completed' ? 'What was done and the proof' : step.status === 'disputed' ? 'What went wrong' : step.status === 'revise' ? 'Why the rate changed' : 'Reason'} <em>*</em></span>
          <textarea rows={2} value={step.note} onChange={(e) => setStep({ ...step, note: e.target.value })} /></label>}
        {step.status === 'confirmed' && d.cheaper_warning && <div className="msg warn">You are choosing a vendor who is not the cheapest. {d.cheaper_warning} You can still confirm; it is noted in the history.</div>}
        {step.status === 'revise' && <p className="muted small">The current rate is kept as version {d.rate_version}; quotations already using it keep their own figures and are listed in the history.</p>}
        <div className="form-actions"><button className="btn" onClick={() => setStep(null)}>Back</button>
          <button className="btn primary" onClick={save}>{step.status === 'confirmed' && d.cheaper_warning ? 'Confirm anyway' : 'Save'}</button></div></div>}
      {d.compare && <div className="panel flush"><h2 style={{ padding: '12px 14px 0' }}>Price comparison — same request to {d.compare.length} vendors</h2>
        <div className="table-wrap"><table className="t"><thead><tr><th>Request</th><th>Vendor</th><th className="num">Price</th><th>Valid until</th><th>Status</th></tr></thead>
          <tbody>{d.compare.map((r: any) => <tr key={r.id} className={r.lowest ? 'is-lowest' : ''}>
            <td>{r.id === d.id ? <b>{r.request_no} (this)</b> : <Link href={`/vendor-requests/${r.id}`}>{r.request_no}</Link>}</td>
            <td>{r.vendor_name}{r.lowest && <span className="lowest">Lowest</span>}</td>
            <td className="num">{r.quoted_cost ? fmtMoney(r.quoted_cost, r.currency) : <span className="muted">waiting</span>}</td>
            <td>{fmtDate(r.rate_valid_until)}{r.expired && <div className="flag">Expired</div>}</td><td className="small">{r.status === 'cancelled' ? 'Cancelled' : r.status === 'requested' ? 'Waiting for price' : r.status === 'quoted' ? 'Quoted' : r.status}</td></tr>)}</tbody></table></div></div>}
      {more && <NewVendorRequest sameAs={{ id: d.id, asked: d.compare ? d.compare.filter((r: any) => r.status !== 'cancelled').map((r: any) => r.vendor_id) : [d.vendor_id] }} onClose={() => setMore(false)} onDone={() => { setMore(false); load(); }} />}
      <div className="cols">
        <div>
          <div className="panel"><h2>Request</h2><p style={{ whiteSpace: 'pre-wrap', marginTop: 0 }}>{d.description}</p>
            {d.completion_note && <div className="msg ok">Completed: {d.completion_note}</div>}{d.issue_note && <div className="msg warn">Problem: {d.issue_note}</div>}
            {d.cancel_reason && <div className="msg">Cancelled: {d.cancel_reason}</div>}</div>
          {d.can.cost && isRate && (d.charges.length > 0 || d.transit_days !== null || d.routing) && <div className="panel"><h2>The rate</h2>
            <dl className="kv"><dt>Transit</dt><dd>{d.transit_days !== null ? `${d.transit_days} days` : '—'}</dd><dt>Free days</dt><dd>{d.free_days ?? '—'}</dd>
              <dt>Routing</dt><dd>{d.routing ?? '—'}</dd><dt>Sailing / flight</dt><dd>{fmtDate(d.etd)}</dd>
              <dt>Included</dt><dd>{d.inclusions ?? '—'}</dd><dt>Not included</dt><dd>{d.exclusions ?? '—'}</dd></dl>
            {d.charges.length > 0 && <table className="t" style={{ marginTop: 8 }}><thead><tr><th>Part</th><th>Charge</th><th>Basis</th><th className="num">Qty</th><th className="num">Amount</th></tr></thead>
              <tbody>{d.charges.map((c: any) => <tr key={c.id}><td className="small">{CHARGE_SECTIONS.find(([k]) => k === c.section)?.[1]}</td><td>{c.description}</td><td className="small">{c.basis ?? ''}</td>
                <td className="num">{Number(c.quantity)}</td><td className="num">{fmtMoney(c.amount, c.currency)}{Number(c.exchange_rate) !== 1 && <div className="muted small">× {Number(c.exchange_rate)}</div>}</td></tr>)}</tbody>
              <tfoot><tr><td colSpan={4}><b>Total</b></td><td className="num"><b>{fmtMoney(d.quoted_cost, d.currency)}</b></td></tr></tfoot></table>}</div>}
          {d.versions.length > 0 && <div className="panel"><h2>Earlier versions of this rate</h2>
            {d.versions.map((v: any) => <div key={v.rate_version} className="small" style={{ padding: '4px 0', borderTop: '1px solid var(--line-soft)' }}>
              <b>Version {v.rate_version}</b>: {fmtMoney(v.snapshot.quoted_cost, v.snapshot.currency)}{v.snapshot.rate_valid_until && <>, valid until {fmtDate(v.snapshot.rate_valid_until)}</>}
              <div className="muted">Replaced {fmtDateTime(v.at)} by {v.replaced_by_name}{v.snapshot.reason && <> — {v.snapshot.reason}</>}</div></div>)}</div>}
          <div className="panel"><h2>Activity history</h2>
            {d.can.update && <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Add a note…" style={{ flex: 1 }} />
              <button className="btn small" disabled={!note.trim()} onClick={async () => { if (await act({ what: 'note', note })) setNote(''); }}>Add</button></div>}
            {[...d.events].reverse().map((e: any, i: number) => <div key={i} className="small" style={{ padding: '5px 0', borderTop: '1px solid var(--line-soft)' }}>
              <b>{e.title}</b>{e.details && <>: {e.details}</>}<div className="muted">{fmtDateTime(e.at)} · {e.user_name}</div></div>)}</div>
        </div>
        <div><div className="panel"><h2>Details</h2><dl className="kv">
          <dt>Vendor</dt><dd>{d.vendor_name}{(d.vendor_contact || d.vendor_phone || d.vendor_email) && <div className="muted small">{[d.vendor_contact, d.vendor_phone, d.vendor_email].filter(Boolean).join(' · ')}</div>}</dd>
          <dt>Service</dt><dd>{d.service_name}</dd>
          {d.rate_source && <><dt>Rate source</dt><dd>{d.rate_source_name}</dd></>}
          <dt>Shipment</dt><dd>{d.job_file_id ? <Link href={`/job-files/${d.job_file_id}`}>{ref}</Link> : '—'}</dd>
          {d.rate_request_no && <><dt>Books the rate</dt><dd><Link href={`/vendor-requests/${d.rate_request_id}`}>{d.rate_request_no}</Link></dd></>}
          <dt>Needed by</dt><dd>{fmtDate(d.needed_by)}</dd><dt>Vendor ref.</dt><dd>{d.vendor_reference ?? '—'}</dd>
          {d.can.cost && <><dt>Rate / cost</dt><dd>{d.quoted_cost ? fmtMoney(d.quoted_cost, d.currency) : '—'}{d.previous_quoted_cost && <div className="muted small">was {fmtMoney(d.previous_quoted_cost, d.currency)}</div>}</dd></>}
          {isRate && <><dt>Rate valid until</dt><dd>{fmtDate(d.rate_valid_until)}</dd><dt>Rate received</dt><dd>{fmtDateTime(d.received_at)}</dd></>}
          <dt>Agent Coordinator</dt><dd>{d.assigned_to_name ?? '—'}
            {d.can.assign && isRate && <select style={{ marginTop: 4 }} value={d.assigned_to ?? ''} aria-label="Agent Coordinator"
              onChange={(e) => act({ what: 'assign', assigned_to: e.target.value || null })}><option value="">Not assigned</option>
              {d.agent_coordinators.map((u: any) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select>}</dd>
          <dt>Confirmed</dt><dd>{fmtDateTime(d.confirmed_at)}</dd><dt>Completed</dt><dd>{fmtDateTime(d.completed_at)}</dd>
          <dt>Requested by</dt><dd>{d.created_by_name}, {fmtDateTime(d.created_at)}</dd>
        </dl></div></div>
      </div>
    </div>
  );
}
