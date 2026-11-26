'use client';
import { useEffect, useState } from 'react';
import { api, fmtDate, fmtMoney } from '@/components/api';

/**
 * 26 Nov: the page behind the Accept / Reject / Negotiate buttons in the quotation email. No sign-in; one answer per link.
 * ?a=accepted|rejected|negotiate opens the matching choice.
 */
export default function Answer({ params }: { params: { token: string } }) {
  const [info, setInfo] = useState<any>(null);
  const [err, setErr] = useState('');
  const [a, setA] = useState('');
  const [reason, setReason] = useState('');
  const [rate, setRate] = useState('');
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  useEffect(() => {
    const pick = new URLSearchParams(window.location.search).get('a');
    if (pick && ['accepted', 'rejected', 'negotiate'].includes(pick)) setA(pick);
    api(`/api/answer/${params.token}`).then(setInfo).catch((e) => setErr(e.message));
  }, [params.token]);
  const send = async (e: React.FormEvent) => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { const r = await api(`/api/answer/${params.token}`, { body: { answer: a, reason, target_rate: rate, comment } }); setDone(r.answer_name); }
    catch (e: any) { setErr(e.message); }
    setBusy(false);
  };
  const btn = (k: string, label: string) => <button type="button" className={`btn${a === k ? ' primary' : ''}`} aria-pressed={a === k} onClick={() => setA(k)}>{label}</button>;
  return (
    <div className="join">
      <img src="/brand/logo-on-dark.png" alt="Reliance Freight Systems LLC" width={220} height={53} className="join-logo" />
      <div className="join-card">
        {!info && !err && <p className="muted">Opening…</p>}
        {!info && err && <><h1>This link can't be used</h1><div className="msg err">{err}</div></>}
        {info && <>
          <h1>Quotation {info.quote_no}{info.version_no > 1 ? ` (revision ${info.version_no})` : ''}</h1>
          <p className="small muted" style={{ marginTop: 0 }}>{info.customer_name}{info.option ? ` · ${info.option}` : ''}</p>
          <p>Total: <b>{fmtMoney(info.total, info.currency)}</b> <span className="small muted">(excluding VAT) · valid until {fmtDate(info.valid_until)}</span></p>
          {done ? <div className="msg ok">Thank you — your answer ({done.toLowerCase()}) has reached our team. We will get back to you shortly.</div>
            : info.answer ? <div className="msg ok">This was answered on {fmtDate(info.answered_at)}: <b>{info.answer_name}</b>. To change it, please reply to our email.</div>
            : info.closed ? <div className="msg warn">{info.closed}</div>
            : <form onSubmit={send}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', margin: '8px 0 12px' }}>{btn('accepted', 'Accept')}{btn('rejected', 'Reject')}{btn('negotiate', 'Negotiate')}</div>
              {a === 'rejected' && <label className="f"><span>Why? <em>*</em></span><textarea rows={3} maxLength={1000} value={reason} onChange={(e) => setReason(e.target.value)} required /></label>}
              {a === 'negotiate' && <label className="f"><span>Your target rate ({info.currency}) <em>*</em></span><input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value)} required /></label>}
              {a && <label className="f"><span>Comment (optional)</span><textarea rows={3} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} /></label>}
              {err && <div className="msg err">{err}</div>}
              {a && <button className="btn primary" style={{ marginTop: 10, width: '100%' }} disabled={busy}>{busy ? 'Sending…' : a === 'accepted' ? 'Confirm I accept' : 'Send'}</button>}
            </form>}
        </>}
      </div>
    </div>
  );
}
