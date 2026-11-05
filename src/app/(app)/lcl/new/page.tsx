'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from '@/components/api';
import { useMe } from '@/components/Shell';
import { LclHeadForm } from '@/components/LclHeadForm';

export default function NewConsolidation() {
  const { can, lk } = useMe();
  const router = useRouter();
  const [f, setF] = useState<any>({ direction: 'export' });
  const [opts, setOpts] = useState<any>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { api('/api/lcl/options').then(setOpts).catch((e) => setErr(e.message)); }, []);
  if (!can('lcl.manage')) return <div className="page"><div className="msg err">You can't create consolidations.</div></div>;
  const save = async () => {
    setErr(''); setBusy(true);
    try { const r = await api('/api/lcl', { body: f }); router.push(`/lcl/${r.id}`); } catch (e: any) { setErr(e.message); setBusy(false); window.scrollTo(0, 0); }
  };
  return (
    <div className="page">
      <div className="page-head"><h1>Create consolidation</h1></div>
      <p className="muted small" style={{ marginTop: -6 }}>One consolidation is one container: one carrier booking, one Master BL, many house shipments. The system gives it a CON reference.</p>
      {err && <div className="msg err">{err}</div>}
      {opts && <LclHeadForm f={f} setF={setF} types={opts.container_types} warehouses={opts.warehouses} vendors={lk.vendors ?? []} />}
      <div className="form-actions"><Link className="btn" href="/lcl">Cancel</Link>
        <button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Create consolidation'}</button></div>
    </div>
  );
}
