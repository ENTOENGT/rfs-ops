'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtMoney } from '@/components/api';

/**
 * The customer copy of a quotation: selling rates and total only. The server sends nothing else for this view
 * (no cost, no margin, no internal history), so nothing can slip onto the printout. Print → "Save as PDF" for a PDF.
 */
export default function QuotePrint({ params }: { params: { id: string } }) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  useEffect(() => { api(`/api/quotations/${params.id}?view=customer`).then(setD).catch((e) => setErr(e.message)); }, [params.id]);
  if (err) return <div className="page"><div className="msg err">{err}</div><Link className="btn" href={`/quotations/${params.id}`}>Back</Link></div>;
  if (!d) return <div className="page muted">Loading…</div>;
  const c = d.company;
  const cargo = [d.cargo_description, d.packages && `${d.packages} packages`, d.gross_weight_kg && `${Number(d.gross_weight_kg).toLocaleString()} kg`,
    d.volume_cbm && `${Number(d.volume_cbm)} CBM`, d.chargeable_weight_kg && `chargeable ${Number(d.chargeable_weight_kg).toLocaleString()} kg`].filter(Boolean).join(' · ');
  const block = (title: string, text?: string | null) => text ? <div className="qp-block"><h3>{title}</h3><p>{text}</p></div> : null;
  return (
    <div className="page qp">
      <style>{`@media print { @page { size: A4 portrait; margin: 14mm; } }`}</style>
      <div className="page-head no-print"><h1>Customer copy — {d.quote_no}</h1><span className="spacer" />
        <Link className="btn" href={`/quotations/${params.id}`}>Back</Link>
        <a className="btn" href={`/api/quotations/${params.id}?format=xlsx`}>Excel</a>
        <button className="btn primary" onClick={() => window.print()}>Print / Save as PDF</button></div>
      <p className="muted small no-print" style={{ marginTop: -6 }}>This is exactly what the customer sees: selling rates only. To get a PDF, click Print and choose "Save as PDF".</p>
      <div className="qp-sheet">
        <div className="qp-top">
          <img src="/brand/logo.png" alt={c.company_name} className="qp-logo" />
          <div className="qp-co"><b>{c.company_name}</b>{c.company_address && <div>{c.company_address}</div>}
            {(c.company_phone || c.company_email) && <div>{[c.company_phone, c.company_email].filter(Boolean).join(' · ')}</div>}
            {c.company_trn && <div>TRN {c.company_trn}</div>}</div>
        </div>
        <h2 className="qp-title">Quotation</h2>
        <div className="qp-meta">
          <div><span>To</span><b>{d.customer.name}</b>{d.customer.contact && <div>Attn: {d.customer.contact}</div>}
            {d.customer.address && <div>{d.customer.address}</div>}{d.customer.trn && <div>TRN {d.customer.trn}</div>}</div>
          <dl>
            <dt>Quotation no.</dt><dd>{d.quote_no}</dd><dt>Date</dt><dd>{fmtDate(d.date)}</dd><dt>Valid until</dt><dd>{fmtDate(d.valid_until)}</dd>
            {d.enquiry_reference && <><dt>Your reference</dt><dd>{d.enquiry_reference}</dd></>}
          </dl>
        </div>
        <dl className="qp-ship">
          <dt>Service</dt><dd>{d.service_name} · {d.direction_name}</dd>
          {(d.origin || d.destination) && <><dt>Route</dt><dd>{[d.origin, d.destination].filter(Boolean).join(' → ')}</dd></>}
          {cargo && <><dt>Cargo</dt><dd>{cargo}</dd></>}
        </dl>
        <table className="qp-lines">
          <thead><tr><th>Description</th><th>Charged</th><th className="num">Qty</th><th className="num">Rate ({d.currency})</th><th className="num">Amount ({d.currency})</th></tr></thead>
          <tbody>{d.lines.map((l: any, i: number) => <tr key={i}><td>{l.description}</td><td>{l.unit_name}</td><td className="num">{Number(l.quantity)}</td>
            <td className="num">{fmtMoney(l.rate, '')}</td><td className="num">{fmtMoney(l.amount, '')}</td></tr>)}</tbody>
          <tfoot><tr><td colSpan={4} className="num"><b>Total</b></td><td className="num"><b>{fmtMoney(d.total, d.currency)}</b></td></tr></tfoot>
        </table>
        {c.quote_vat_note && <p className="qp-note">{c.quote_vat_note}</p>}
        {block('Scope of service', d.scope)}{block('Exclusions', d.exclusions)}{block('Terms and conditions', d.terms)}
        <p className="qp-sign">Prepared by {d.prepared_by}</p>
      </div>
    </div>
  );
}
