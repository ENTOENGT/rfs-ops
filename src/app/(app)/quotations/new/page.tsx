'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { api } from '@/components/api';
import { useMe } from '@/components/Shell';
import { QuoteFields, emptyLine } from '@/components/QuoteForm';

export default function NewQuotation() {
  const { can } = useMe();
  const router = useRouter();
  const [f, setF] = useState<any>({ service_type: 'sea_fcl', direction: 'import', lines: [emptyLine()] });
  const [fe, setFe] = useState<Record<string, string>>({});
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  if (!can('quotes.create')) return <div className="page"><div className="msg err">You can't create quotations.</div></div>;
  const save = async () => {
    setErr(''); setFe({}); setBusy(true);
    try { const r = await api('/api/quotations', { body: f }); router.push(`/quotations/${r.id}`); }
    catch (e: any) { setBusy(false); setErr(e.message); if (e.details?.fields) setFe(e.details.fields); window.scrollTo(0, 0); }
  };
  return (
    <div className="page">
      <div className="page-head"><h1>New quotation</h1></div>
      {err && <div className="msg err">{err}</div>}
      <QuoteFields f={f} setF={setF} fe={fe} />
      <div className="form-actions"><Link className="btn" href="/quotations">Cancel</Link>
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save draft'}</button></div>
    </div>
  );
}
