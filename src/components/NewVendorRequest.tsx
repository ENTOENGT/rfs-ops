'use client';
import { useState } from 'react';
import { api } from '@/components/api';
import { useMe } from '@/components/Shell';

export const VR_SERVICES: [string, string][] = [['rate', 'Rate request (for a quotation)'], ['booking', 'Freight booking'], ['trucking', 'Trucking'],
  ['customs', 'Customs brokerage'], ['warehousing', 'Warehousing'], ['courier', 'Courier'], ['documentation', 'Documentation'], ['other', 'Other']];

/**
 * New vendor request. For a rate request you can tick several vendors: the same request goes to each of them and their
 * prices are compared side by side. `sameAs` = add one more vendor to an existing rate request.
 */
export function NewVendorRequest({ jobNo, service = 'rate', sameAs, description, onClose, onDone }: {
  jobNo?: string; service?: string; sameAs?: { id: string; asked: string[] }; description?: string;
  onClose: () => void; onDone: (r: { id: string; ids: string[]; request_nos: string[] }) => void;
}) {
  const { me, lk } = useMe();
  const cost = me.financial_access.buyingView;
  const [nw, setNw] = useState<any>({ service, job_no: jobNo ?? '', description: description ?? '', vendor_ids: [] as string[] });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const multi = nw.service === 'rate';
  const vendors = (lk.vendors ?? []).filter((v: any) => !sameAs?.asked.includes(v.id));
  const pick = (id: string) => setNw({ ...nw, vendor_ids: nw.vendor_ids.includes(id) ? nw.vendor_ids.filter((x: string) => x !== id) : [...nw.vendor_ids, id] });
  const save = async () => {
    setErr(''); setBusy(true);
    try {
      const body = sameAs ? { same_as: sameAs.id, vendor_ids: nw.vendor_ids, needed_by: nw.needed_by || undefined }
        : { ...nw, vendor_ids: multi ? nw.vendor_ids : undefined, vendor_id: multi ? undefined : nw.vendor_id, quoted_cost: !multi || nw.vendor_ids.length === 1 ? nw.quoted_cost : undefined };
      onDone(await api('/api/vendor-requests', { body }));
    } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="modal-bg" onClick={(e) => e.target === e.currentTarget && onClose()}><div className="modal" role="dialog" aria-label="New vendor request">
      <h2>{sameAs ? 'Ask more vendors for the same rate' : multi ? 'Ask vendors for a rate' : 'New vendor request'}</h2>
      {err && <div className="msg err">{err}</div>}
      {vendors.length === 0 && <div className="msg warn">{sameAs ? 'Every vendor has already been asked.' : 'No vendors yet — add them under Vendors first.'}</div>}
      <div className="grid g2">
        {!sameAs && <label className="f"><span>Service <em>*</em></span><select value={nw.service} onChange={(e) => setNw({ ...nw, service: e.target.value })}>
          {VR_SERVICES.map(([c, n]) => <option key={c} value={c}>{n}</option>)}</select></label>}
        {!sameAs && <label className="f"><span>Job No.</span><input value={nw.job_no} onChange={(e) => setNw({ ...nw, job_no: e.target.value })} readOnly={!!jobNo} /></label>}
        {multi || sameAs ? <div className="f span2"><span>Vendors <em>*</em> <span className="muted small">— tick all the vendors you want to ask; the same request goes to each one</span></span>
          <div className="checks">{vendors.map((v: any) => <label key={v.id} className="check"><input type="checkbox" checked={nw.vendor_ids.includes(v.id)} onChange={() => pick(v.id)} /> {v.name}</label>)}</div>
          {nw.vendor_ids.length > 0 && <div className="muted small">{nw.vendor_ids.length} vendor(s) chosen</div>}</div>
          : <label className="f"><span>Vendor <em>*</em></span><select value={nw.vendor_id ?? ''} onChange={(e) => setNw({ ...nw, vendor_id: e.target.value })}><option value="">Choose vendor</option>
            {vendors.map((v: any) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>}
        <label className="f"><span>{multi ? 'Reply needed by' : 'Needed by'}</span><input type="date" value={nw.needed_by ?? ''} onChange={(e) => setNw({ ...nw, needed_by: e.target.value })} /></label>
        {!sameAs && cost && (!multi || nw.vendor_ids.length <= 1) && <label className="f"><span>Vendor price (if known)</span><input value={nw.quoted_cost ?? ''} onChange={(e) => setNw({ ...nw, quoted_cost: e.target.value })} inputMode="decimal" /></label>}
        {!sameAs && <label className="f span2"><span>{multi ? 'What to quote (route, cargo, containers, dates)' : 'What the vendor must do'} <em>*</em></span>
          <textarea rows={3} value={nw.description} onChange={(e) => setNw({ ...nw, description: e.target.value })} /></label>}
      </div>
      <div className="actions"><button className="btn" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy} onClick={save}>{multi || sameAs ? `Send to ${nw.vendor_ids.length || ''} vendor${nw.vendor_ids.length === 1 ? '' : 's'}` : 'Create request'}</button></div>
    </div></div>
  );
}
