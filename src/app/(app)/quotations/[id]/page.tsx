'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime, fmtMoney } from '@/components/api';
import { useMe } from '@/components/Shell';
import { QuoteFields } from '@/components/QuoteForm';
import { MODES } from '@/lib/jobfileRules';

const HEAD = ['customer_id', 'service_type', 'direction', 'enquiry_reference', 'origin', 'destination', 'cargo_description', 'packages',
  'gross_weight_kg', 'volume_cbm', 'chargeable_weight_kg', 'valid_until', 'scope', 'exclusions', 'terms'];

export default function Quotation({ params }: { params: { id: string } }) {
  const { me } = useMe();
  const router = useRouter();
  const [d, setD] = useState<any>(null);
  const [edit, setEdit] = useState<any>(null);
  const [accept, setAccept] = useState<any>(null);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const load = () => api(`/api/quotations/${params.id}`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [params.id]);
  const act = async (b: any, done: string) => {
    setErr(''); setOk('');
    try {
      const r = await api(`/api/quotations/${params.id}`, { body: b });
      if (b.action === 'copy') { router.push(`/quotations/${r.id}`); return; }
      setD(r); setOk(r.created_job_file ? `${done} Job File ${r.created_job_file.job_no} created.` : done); setAccept(null);
    } catch (e: any) { setErr(e.message); window.scrollTo(0, 0); }
  };
  const ask = (action: string, q: string, done: string) => { const reason = prompt(q); if (reason) act({ action, reason }, done); };
  const saveEdit = async () => {
    setErr('');
    try {
      setD(await api(`/api/quotations/${params.id}`, { method: 'PATCH', body: { ...Object.fromEntries(HEAD.map((k) => [k, edit[k] ?? null])), lines: edit.lines } }));
      setEdit(null); setOk('Saved');
    } catch (e: any) { setErr(e.message); window.scrollTo(0, 0); }
  };
  if (!d) return <div className="page">{err ? <div className="msg err">{err}</div> : <p className="muted">Loading…</p>}</div>;
  const { buyingView, sellingView, profitView } = me.financial_access;
  const cur = d.currency;
  const kv = (k: string, v: any) => <><dt>{k}</dt><dd>{v || v === 0 ? v : '—'}</dd></>;
  return (
    <div className="page">
      <div className="page-head">
        <h1>Quotation {d.quote_no}</h1><span className="badge" style={{ background: d.status_color }}>{d.status_name}</span>
        <span className="spacer" />
        {d.can.edit && !edit && <button className="btn" onClick={() => setEdit({ ...d, lines: d.lines.map((l: any) => ({ ...l })) })}>Edit</button>}
        {d.can.submit && <button className="btn primary" onClick={() => act({ action: 'submit' }, 'Done.')}>Send for approval / approve</button>}
        {d.can.approve && <><button className="btn primary" onClick={() => act({ action: 'approve' }, 'Approved.')}>Approve</button>
          <button className="btn" onClick={() => ask('reject_approval', 'Why is it not approved?', 'Sent back to draft.')}>Don't approve</button></>}
        {d.can.send && <button className="btn" onClick={() => act({ action: 'send' }, 'Marked as sent.')}>Mark as sent</button>}
        {d.can.accept && <button className="btn primary" onClick={() => setAccept({ job_no: '', mode: MODES.some(([c]) => c === d.service_type) ? d.service_type : 'sea_fcl' })}>Customer accepted</button>}
        {d.can.decline && <button className="btn" onClick={() => ask('decline', 'Why did the customer not accept?', 'Recorded.')}>Customer declined</button>}
        {d.can.customer_copy && <><Link className="btn" href={`/quotations/${d.id}/print`}>Print / PDF</Link>
          <a className="btn" href={`/api/quotations/${d.id}?format=xlsx`}>Excel</a></>}
        {d.can.copy && <button className="btn" onClick={() => act({ action: 'copy' }, '')}>Copy</button>}
        {d.can.cancel && <button className="btn danger" onClick={() => ask('cancel', 'Cancel this quotation? Give a reason:', 'Cancelled.')}>Cancel</button>}
      </div>
      {err && <div className="msg err">{err}</div>}
      {ok && <div className="msg ok">{ok}</div>}
      {d.status === 'pending_approval' && <div className="msg warn">The margin is below the {d.min_margin_pct}% minimum, so a manager must approve it before it goes to the customer.</div>}
      {d.status === 'expired' && <div className="msg warn">The rates expired on {fmtDate(d.valid_until)}. Edit the validity date (it then needs approval again) or make a copy.</div>}
      {d.decline_reason && ['draft', 'rejected', 'cancelled'].includes(d.status) && <div className="msg">Note: {d.decline_reason}</div>}
      {!d.can.customer_copy && ['draft', 'pending_approval'].includes(d.status) && sellingView &&
        <p className="muted small">Print / PDF and Excel for the customer appear once the quotation is approved.</p>}
      {d.job_file_id && <div className="msg ok">Job File: <Link href={`/job-files/${d.job_file_id}`}><b>{d.job_no}</b></Link></div>}

      {accept && <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && setAccept(null)}>
        <div className="modal" role="dialog" aria-label="Customer accepted">
          <h2>Customer accepted {d.quote_no}</h2>
          <p className="small">A Job File is created from this quotation. Type the Job No. as your company uses it.</p>
          <div className="grid g2">
            <label className="f"><span>Job No. <em>*</em></span><input autoFocus value={accept.job_no} onChange={(e) => setAccept({ ...accept, job_no: e.target.value })} maxLength={40} /></label>
            {!MODES.some(([c]) => c === d.service_type) && <label className="f"><span>Mode</span><select value={accept.mode} onChange={(e) => setAccept({ ...accept, mode: e.target.value })}>
              {MODES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>}
          </div>
          <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 10 }}>
            {[['needs_clearance', 'Needs customs clearance'], ['needs_transport', 'Needs transport'], ['needs_warehouse', 'Goes into our warehouse']].map(([k, t]) =>
              <label key={k} className="small" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="checkbox" style={{ width: 'auto' }} checked={!!accept[k]} onChange={(e) => setAccept({ ...accept, [k]: e.target.checked })} />{t}</label>)}
          </div>
          <div className="actions"><button className="btn" onClick={() => setAccept(null)}>Cancel</button>
            <button className="btn primary" disabled={!accept.job_no.trim()} onClick={() => act({ action: 'accept', ...accept }, 'Accepted.')}>Create Job File</button></div>
        </div></div>}

      {edit ? <>
        {d.status !== 'draft' && <div className="msg warn">Saving changes puts this quotation back to draft — it must be approved again.</div>}
        <QuoteFields f={edit} setF={setEdit} minMargin={d.min_margin_pct} />
        <div className="form-actions"><button className="btn" onClick={() => setEdit(null)}>Cancel</button>
          <button className="btn primary" onClick={saveEdit}>Save changes</button></div>
      </> : <div className="cols">
        <div>
          <div className="panel"><h2>Charges ({cur}, excluding VAT)</h2>
            <div className="table-wrap"><table className="t">
              <thead><tr><th>Charge</th><th>Charged</th><th className="num">Qty</th>
                {buyingView && <th className="num">Cost rate</th>}{buyingView && <th className="num">Cost</th>}{profitView && <th>Margin</th>}
                {sellingView && <th className="num">Selling rate</th>}{sellingView && <th className="num">Amount</th>}</tr></thead>
              <tbody>{d.lines.map((l: any) => <tr key={l.id}><td>{l.description}</td><td className="small">{l.unit_name}</td><td className="num">{Number(l.quantity)}</td>
                {buyingView && <td className="num">{fmtMoney(l.cost_rate, '')}</td>}{buyingView && <td className="num">{fmtMoney(l.cost_amount, '')}</td>}
                {profitView && <td className="small">{l.margin_type === 'percent' ? `${Number(l.margin_value)}%` : l.margin_type === 'amount' ? `+${fmtMoney(l.margin_value, '')}` : <span className="muted">typed</span>}</td>}
                {sellingView && <td className="num">{fmtMoney(l.sell_rate, '')}</td>}{sellingView && <td className="num">{fmtMoney(l.sell_amount, '')}</td>}</tr>)}</tbody>
            </table></div>
            <dl className="kv" style={{ marginTop: 12 }}>
              {d.totals.cost_total !== undefined && <><dt>Total cost</dt><dd>{fmtMoney(d.totals.cost_total, cur)}</dd></>}
              {d.totals.sell_total !== undefined && <><dt>Total to customer</dt><dd><b>{fmtMoney(d.totals.sell_total, cur)}</b></dd></>}
              {d.totals.margin !== undefined && <><dt>Margin</dt><dd>{fmtMoney(d.totals.margin, cur)}{d.totals.margin_pct !== null && ` (${d.totals.margin_pct}%)`}
                {d.totals.margin_pct !== null && Number(d.totals.margin_pct) < d.min_margin_pct && <span className="flag" style={{ marginLeft: 8 }}>Below {d.min_margin_pct}%</span>}</dd></>}
            </dl>
          </div>
          <div className="panel"><h2>Terms</h2><dl className="kv">{kv('Scope', d.scope)}{kv('Exclusions', d.exclusions)}{kv('Terms', d.terms)}</dl></div>
        </div>
        <div>
          <div className="panel"><h2>Enquiry</h2><dl className="kv">
            {kv('Customer', d.customer_name)}{kv('Service', d.service_name)}{kv('Direction', d.direction_name)}{kv('Enquiry ref.', d.enquiry_reference)}
            {kv('Route', [d.origin, d.destination].filter(Boolean).join(' → '))}
            {kv('Cargo', [d.cargo_description, d.packages && `${d.packages} pkgs`, d.gross_weight_kg && `${Number(d.gross_weight_kg).toLocaleString()} kg`,
              d.volume_cbm && `${d.volume_cbm} CBM`, d.chargeable_weight_kg && `chargeable ${Number(d.chargeable_weight_kg).toLocaleString()} kg`].filter(Boolean).join(' · '))}
            {kv('Valid until', fmtDate(d.valid_until))}{kv('Prepared by', d.created_by_name)}{kv('Approved by', d.approved_by_name && `${d.approved_by_name}, ${fmtDateTime(d.approved_at)}`)}
          </dl></div>
          <div className="panel"><h2>History</h2>
            {[...d.events].reverse().map((e: any, i: number) => <div key={i} className="small" style={{ padding: '5px 0', borderTop: '1px solid var(--line-soft)' }}>
              <b>{e.title}</b>{e.details && <>: {e.details}</>}<div className="muted">{fmtDateTime(e.at)} · {e.user_name}</div></div>)}
          </div>
        </div>
      </div>}
    </div>
  );
}
