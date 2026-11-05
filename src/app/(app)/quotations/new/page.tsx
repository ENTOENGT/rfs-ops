'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import { api } from '@/components/api';
import { useMe } from '@/components/Shell';
import { QuoteFields, emptyLine } from '@/components/QuoteForm';
import { SERVICE_TYPES } from '@/lib/jobfileRules';

function NewQuotationForm() {
  const { can } = useMe();
  const router = useRouter();
  const jobFileId = useSearchParams().get('job_file');
  const [f, setF] = useState<any>({ service_type: 'sea_fcl', direction: 'import', lines: [emptyLine()] });
  const [file, setFile] = useState<any>(null);
  const [fe, setFe] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  // Made from a Job File (enquiry): same customer and shipment details, and its vendor rates to pick from
  useEffect(() => {
    if (!jobFileId) return;
    api(`/api/job-files/${jobFileId}`).then((j) => {
      setFile(j);
      setF((x: any) => ({ ...x, job_file_id: j.id, customer_id: j.customer_id, direction: j.direction,
        service_type: SERVICE_TYPES.some(([c]) => c === j.mode) ? j.mode : x.service_type, enquiry_reference: j.customer_reference ?? '',
        origin: j.origin ?? j.port_of_loading ?? '', destination: j.destination ?? j.port_of_discharge ?? '', cargo_description: j.cargo_description ?? '',
        packages: j.packages ?? '', gross_weight_kg: j.gross_weight_kg ?? '', volume_cbm: j.volume_cbm ?? '', chargeable_weight_kg: j.chargeable_weight_kg ?? '' }));
    }).catch((e) => setErr(e.message));
  }, [jobFileId]);
  if (!can('quotes.create')) return <div className="page"><div className="msg err">You can't create quotations.</div></div>;
  const save = async () => {
    setErr(''); setFe({}); setBusy(true);
    try { const r = await api('/api/quotations', { body: f }); router.push(`/quotations/${r.id}`); }
    catch (e: any) { setBusy(false); setErr(e.message); if (e.details?.fields) setFe(e.details.fields); window.scrollTo(0, 0); }
  };
  const rates = (file?.vendor_requests ?? []).filter((r: any) => r.quoted_cost);
  return (
    <div className="page">
      <div className="page-head"><h1>New quotation{file && <> for {file.job_no ? `Job No. ${file.job_no}` : file.enquiry_ref}</>}</h1></div>
      {err && <div className="msg err">{err}</div>}
      {file && rates.length === 0 && file.vendor_requests !== null && <div className="msg">No vendor has given a price on this Job No. yet. You can still type the cost yourself.</div>}
      <QuoteFields f={f} setF={setF} fe={fe} vendorRates={rates} jobNo={file?.job_no ?? file?.enquiry_ref} />
      <div className="form-actions"><Link className="btn" href={file ? `/job-files/${file.id}` : '/quotations'}>Cancel</Link>
        <button className="btn primary" disabled={busy || (!!jobFileId && !file)} onClick={save}>{busy ? 'Saving…' : 'Save draft'}</button></div>
    </div>
  );
}

export default function NewQuotation() {
  return <Suspense fallback={<div className="page"><p className="muted">Loading…</p></div>}><NewQuotationForm /></Suspense>;
}
