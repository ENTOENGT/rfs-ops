'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtDateTime, fmtMoney } from '@/components/api';
import { useMe } from '@/components/Shell';
import { QuoteFields } from '@/components/QuoteForm';
import { EmailButton } from '@/components/EmailButton';
import { MODES } from '@/lib/jobfileRules';
import { uploadToShipment } from '@/components/CommercialPanels';
import { RESPONSES } from '@/lib/commercialRules';

/** The customer confirmed (file-linked quotation): their email / document, or how and when they confirmed. */
function ConfirmModal({ d, onClose, act }: { d: any; onClose: () => void; act: (b: any, done: string) => Promise<void> }) {
  const [file, setFile] = useState<File | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    setBusy(true); setErr('');
    try {
      const document_id = file ? await uploadToShipment(d.job_file_id, file, 'customer_confirmation', `Confirmation of ${d.quote_no} v${d.version_no}`) : undefined;
      await act({ action: 'accept', document_id, evidence_note: note || undefined }, 'Customer confirmation saved.');
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}>
    <div className="modal" role="dialog" aria-label="Customer confirmed">
      <h2>Customer confirmed {d.quote_no}{d.version_no > 1 ? ` v${d.version_no}` : ''}</h2>
      <p className="small">This version is kept as the approved one, the system gives the shipment its Shipping Ref, and the next step is the booking.
        Any other open quotation on {d.enquiry_ref ?? d.job_no} is cancelled.</p>
      {err && <div className="msg err">{err}</div>}
      <label className="f"><span>Customer's confirmation (email saved as .msg / .eml / PDF, or a signed copy)</span><input type="file" onChange={(e) => setFile(e.target.files?.[0] ?? null)} /></label>
      <label className="f"><span>Or: how and when they confirmed {!file && <em>*</em>}</span><input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Omar confirmed by phone, 5 Nov 10:15" /></label>
      <div className="actions"><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || (!file && note.trim().length < 10)} onClick={go}>{busy ? 'Saving…' : 'Save confirmation'}</button></div>
    </div></div>;
}

const HEAD = ['customer_id', 'service_type', 'direction', 'enquiry_reference', 'origin', 'destination', 'cargo_description', 'packages',
  'gross_weight_kg', 'volume_cbm', 'chargeable_weight_kg', 'valid_until', 'scope', 'exclusions', 'terms'];

export default function Quotation({ params }: { params: { id: string } }) {
  const { me } = useMe();
  const router = useRouter();
  const [d, setD] = useState<any>(null);
  const [edit, setEdit] = useState<any>(null);
  const [accept, setAccept] = useState<any>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const load = () => api(`/api/quotations/${params.id}`).then(setD).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, [params.id]);
  const act = async (b: any, done: string) => {
    setErr(''); setOk('');
    try {
      const r = await api(`/api/quotations/${params.id}`, { body: b });
      if (b.action === 'copy') { router.push(`/quotations/${r.id}`); return; }
      setD(r); setOk(r.created_job_file ? (d.job_file_id ? (r.created_job_file.shipping_ref ? `${done} Shipping Ref ${r.created_job_file.shipping_ref} — now book it with the agent / carrier.` : done)
        : `${done} Job File ${r.created_job_file.job_no} created.`) : done); setAccept(null); setConfirmOpen(false);
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
        <h1>Quotation {d.quote_no}{d.version_no > 1 && <span className="muted"> v{d.version_no}</span>}</h1><span className="badge" style={{ background: d.status_color }}>{d.status_name}</span>
        {d.loss && <span className="loss-tag">LOSS</span>}
        <span className="spacer" />
        {d.can.edit && !edit && <button className="btn" onClick={() => setEdit({ ...d, lines: d.lines.map((l: any) => ({ ...l })) })}>Edit</button>}
        {d.can.submit && <button className="btn primary" onClick={() => (!d.loss || confirm('Selling is below cost — this is a LOSS quotation. Send it for approval anyway?')) && act({ action: 'submit' }, 'Done.')}>Send for approval / approve</button>}
        {d.can.salesman_approve && <><button className="btn primary" onClick={() => (!d.loss || confirm('This is a LOSS quotation (selling below cost). Approve it?')) && act({ action: 'salesman_approve' }, 'Approved.')}>Approve{d.salesman_id !== me.id ? ' (for the Salesman)' : ''}</button>
          <button className="btn" onClick={() => ask('salesman_return', 'What has to change? (it goes back to the Coordinator)', 'Returned for revision.')}>Return for revision</button>
          <button className="btn danger" onClick={() => ask('salesman_reject', 'Why is it rejected?', 'Rejected.')}>Reject</button></>}
        {d.can.approve && <><button className="btn primary" onClick={() => act({ action: 'approve' }, 'Approved.')}>{d.salesman_id && d.approvals.salesman === 'waiting' ? 'Approve the margin' : 'Approve'}</button>
          <button className="btn" onClick={() => ask('reject_approval', 'Why is it not approved?', 'Sent back to draft.')}>Don't approve</button></>}
        {d.can.send && <button className="btn" onClick={() => act({ action: 'send' }, 'Marked as sent.')}>Mark as sent</button>}
        {d.can.accept && <button className="btn primary" onClick={() => d.job_file_id ? setConfirmOpen(true)
          : setAccept({ job_no: '', mode: MODES.some(([c]) => c === d.service_type) ? d.service_type : 'sea_fcl' })}>Customer confirmed</button>}
        {d.can.revise && <button className="btn" onClick={() => {
          const reason = prompt('Why revise it? (this version is kept, a new version opens as a draft)');
          if (reason) act({ action: 'revise', reason, customer_asked: confirm('Did the customer ask for the change? (OK = yes)') }, `Version ${d.version_no + 1} opened.`); }}>Revise</button>}
        {d.can.respond && <button className="btn" onClick={() => {
          const note = prompt('What did the customer say? (leave empty for "no reply yet")');
          if (note !== null) act({ action: 'response', response: note.trim() ? 'note' : 'no_reply', note: note.trim() || undefined }, 'Recorded.'); }}>Customer response</button>}
        {d.can.decline && <button className="btn" onClick={() => ask('decline', 'Why did the customer not accept?', 'Recorded.')}>Customer declined</button>}
        {d.can.customer_copy && <><Link className="btn" href={`/quotations/${d.id}/print`}>Print / PDF</Link>
          <a className="btn" href={`/api/quotations/${d.id}?format=xlsx`}>Excel</a>
          <EmailButton kind="quotation" id={d.id} label="Email customer" onLogged={load} /></>}
        {d.can.copy && <button className="btn" onClick={() => act({ action: 'copy' }, '')}>Copy</button>}
        {d.can.cancel && <button className="btn danger" onClick={() => ask('cancel', 'Cancel this quotation? Give a reason:', 'Cancelled.')}>Cancel</button>}
      </div>
      {err && <div className="msg err">{err}</div>}
      {ok && <div className="msg ok">{ok}</div>}
      {d.loss && <div className="msg err"><b>Loss quotation:</b> the selling price is below cost{d.totals.margin !== undefined && <> ({fmtMoney(d.totals.margin, cur)})</>}. It needs the Salesman's and a manager's approval.</div>}
      {d.status === 'pending_approval' && <div className="msg warn">Waiting for approval before it can go to the customer:
        {d.approvals.salesman && <> Salesman {d.salesman_name} — <b>{d.approvals.salesman === 'waiting' ? 'waiting' : d.approvals.salesman}</b>.</>}
        {d.approvals.manager && <> Manager (margin below {d.min_margin_pct}%) — <b>{d.approvals.manager}</b>.</>}</div>}
      {d.salesman_decision === 'returned' && d.status === 'draft' && <div className="msg warn">Returned for revision by {d.salesman_decided_by_name}: {d.salesman_note}</div>}
      {d.status === 'expired' && <div className="msg warn">The rates expired on {fmtDate(d.valid_until)}. Edit the validity date (it then needs approval again) or make a copy.</div>}
      {d.decline_reason && ['draft', 'rejected', 'cancelled'].includes(d.status) && <div className="msg">Note: {d.decline_reason}</div>}
      {!d.can.customer_copy && ['draft', 'pending_approval'].includes(d.status) && sellingView &&
        <p className="muted small">Print / PDF and Excel for the customer appear once the quotation is approved.</p>}
      {d.job_file_id && <div className="msg ok">Shipment: <Link href={`/job-files/${d.job_file_id}`}><b>{d.job_no ?? d.shipping_ref ?? d.enquiry_ref}</b></Link>
        {d.enquiry_ref && <span className="muted small"> · Enquiry Ref {d.enquiry_ref}{d.shipping_ref && ` · Shipping Ref ${d.shipping_ref}`}{d.job_no && ` · Job No. ${d.job_no}`}</span>}</div>}
      {confirmOpen && <ConfirmModal d={d} onClose={() => setConfirmOpen(false)} act={act} />}
      {d.rate_warnings?.length > 0 && <div className="msg warn"><b>Another vendor gave a lower price for the same request.</b>
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{d.rate_warnings.map((w: string) => <li key={w}>{w}</li>)}</ul></div>}

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
        <QuoteFields f={edit} setF={setEdit} minMargin={d.min_margin_pct} vendorRates={d.vendor_rates} jobNo={d.job_no ?? d.enquiry_ref ?? undefined} />
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
            {kv('Valid until', fmtDate(d.valid_until))}{kv('Prepared by', d.created_by_name)}{kv('Responsible Salesman', d.salesman_name)}
            {kv('Salesman decision', d.salesman_decision && `${d.salesman_decision} by ${d.salesman_decided_by_name}, ${fmtDateTime(d.salesman_decided_at)}`)}
            {kv('Approved by', d.approved_by_name && `${d.approved_by_name}, ${fmtDateTime(d.approved_at)}`)}
          </dl></div>
          {(d.versions.length > 0 || d.responses.length > 0) && <div className="panel"><h2>Versions and customer responses</h2>
            {d.responses.map((r: any, i: number) => <div key={`r${i}`} className="small" style={{ padding: '4px 0', borderTop: '1px solid var(--line-soft)' }}>
              <b>Customer: {RESPONSES.find(([k]) => k === r.response)?.[1] ?? r.response}</b> (v{r.version_no}){r.note && <>: {r.note}</>}{r.document_id && <> · evidence attached</>}
              <div className="muted">{fmtDateTime(r.at)} · {r.user_name}</div></div>)}
            {d.versions.map((v: any, i: number) => <div key={`v${i}`} className="small" style={{ padding: '4px 0', borderTop: '1px solid var(--line-soft)' }}>
              <b>Version {v.version_no}</b> kept — {v.reason}<div className="muted">{fmtDateTime(v.at)} · {v.made_by_name}</div></div>)}
          </div>}
          <div className="panel"><h2>Activity history</h2>
            {[...d.events].reverse().map((e: any, i: number) => <div key={i} className="small" style={{ padding: '5px 0', borderTop: '1px solid var(--line-soft)' }}>
              <b>{e.title}</b>{e.details && <>: {e.details}</>}<div className="muted">{fmtDateTime(e.at)} · {e.user_name}</div></div>)}
          </div>
        </div>
      </div>}
    </div>
  );
}
