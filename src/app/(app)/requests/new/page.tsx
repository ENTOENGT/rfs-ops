'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import RequestForm from '@/components/RequestForm';
import { api } from '@/components/api';

/** New transport request — from a shipment (?job_file=…) it starts filled in with the shipment's details (step 5). */
function NewRequestInner() {
  const sp = useSearchParams();
  const fileId = sp.get('job_file');
  const [pre, setPre] = useState<any>(fileId ? null : {});
  const [err, setErr] = useState('');
  useEffect(() => { if (fileId) api(`/api/job-files/${fileId}/transport-prefill`).then(setPre).catch((e) => { setErr(e.message); setPre({}); }); }, [fileId]);
  if (!pre) return <div className="page"><p className="muted">Filling in from the shipment…</p></div>;
  return <>
    {err && <div className="page" style={{ paddingBottom: 0 }}><div className="msg warn">Could not fill it in from the shipment: {err}</div></div>}
    {pre.from_shipment && <div className="page" style={{ paddingBottom: 0 }}><div className="msg ok">Filled in from shipment <Link href={`/job-files/${pre.from_shipment.id}`}>{pre.from_shipment.ref}</Link>.
      Check the date, pickup and delivery before sending.</div></div>}
    <RequestForm prefill={pre} />
  </>;
}
export default function NewRequest() { return <Suspense><NewRequestInner /></Suspense>; }
