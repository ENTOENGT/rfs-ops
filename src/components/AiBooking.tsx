'use client';
import { useEffect, useRef, useState } from 'react';
import { api, fmtDate, fmtDateTime } from './api';

const KIND: Record<string, [string, string]> = { confirmation: ['Booking confirmed', 'rec-best'], update: ['Update', 'rec-ok'], pending: ['Still pending', 'rec-ok'] };
const show = (k: string, v: unknown) => (v === null || v === undefined || v === '' ? '—' : ['etd', 'eta', 'atd', 'ata'].includes(k) ? fmtDate(String(v))
  : k === 'routing_type' ? (v === 'via' ? 'Via / transshipment' : 'Direct') : String(v));

/**
 * 24 Nov (migration 042), on the shipment once the booking is sent: the line's / agent's emails about it, read by the AI by
 * itself (once each). Each shows what would change (old → new); untick what is wrong, correct a value, then "Save booking".
 * Nothing changes until a person presses it.
 */
export function AiBooking({ fileId, onChanged }: { fileId: string; onChanged: () => void }) {
  const [d, setD] = useState<any>(null);
  const [reading, setReading] = useState<any>(null);
  const [err, setErr] = useState('');
  const [edit, setEdit] = useState<Record<string, { on: Record<string, boolean>; val: Record<string, string>; cont: Record<string, boolean> }>>({});
  const tried = useRef<Set<string>>(new Set());
  const load = () => api(`/api/job-files/${fileId}/ai-booking`).then(setD).catch(() => setD(null));
  useEffect(() => { load(); }, [fileId]);
  const read = async (m: any) => {
    tried.current.add(m.id); setReading(m); setErr('');
    try { await api(`/api/job-files/${fileId}/ai-booking`, { body: { email_id: m.id } }); } catch (e: any) { setErr(e.message); }
    setReading(null); load();
  };
  useEffect(() => { const m = d?.unread?.find((x: any) => !tried.current.has(x.id)); if (d?.configured && d.watching && m && !reading) read(m); }, [d, reading]);
  if (!d?.allowed || !d.watching || (!d.open?.length && !d.unread?.length && !reading && !err && !(d.done ?? []).length)) return null;
  const e = (s: any) => edit[s.id] ?? { on: Object.fromEntries(s.changes.map((c: any) => [c.key, true])), val: Object.fromEntries(s.changes.map((c: any) => [c.key, String(c.new ?? '')])),
    cont: Object.fromEntries(s.new_containers.map((k: any) => [k.container_no, true])) };
  const setE = (s: any, v: any) => setEdit({ ...edit, [s.id]: { ...e(s), ...v } });
  const act = async (s: any, b: any) => {
    setErr('');
    try { setD(await api(`/api/ai/bookings/${s.id}`, { body: b })); onChanged(); } catch (x: any) { setErr(x.message); }
  };
  const save = (s: any) => { const v = e(s);
    act(s, { action: 'save', fields: Object.fromEntries(s.changes.filter((c: any) => v.on[c.key]).map((c: any) => [c.key, v.val[c.key]])),
      containers: s.new_containers.filter((k: any) => v.cont[k.container_no]).map((k: any) => k.container_no) }); };
  return (
    <div className="ai-box" role="region" aria-label="Booking emails read by AI">
      <div className="ai-head"><span className="ai-tag">AI</span><b>Booking emails</b><span className="muted small">— from {d.booking.vendor_name} about {d.booking.request_no}, read by AI. Check, then save.</span></div>
      {reading && <p className="small">Reading the email from {reading.from_name || reading.from_addr}…</p>}
      {err && <div className="msg err small">{err}</div>}
      {d.open.map((s: any) => { const v = e(s), a = s.answers; const nothing = !s.changes.length && !s.new_containers.length; return <div key={s.id} className="ai-item">
        <p className="small" style={{ margin: '2px 0' }}>{KIND[a.kind] && <span className={`rec-tag ${KIND[a.kind][1]}`}>{KIND[a.kind][0]}</span>}{' '}
          <b>{s.from_name || s.from_addr}</b> · {fmtDateTime(s.sent_at)} — {s.summary}</p>
        {a.quote && <span className="ai-quote">“{a.quote}”</span>}
        {(s.unclear ?? []).map((u: any, i: number) => <p key={i} className="small" style={{ color: '#B7791F', margin: '2px 0' }}>{u.note}</p>)}
        {nothing && <p className="small muted" style={{ margin: '4px 0' }}>Everything in this email is already on the shipment.</p>}
        {s.changes.length > 0 && <div className="table-wrap"><table className="t compact" style={{ marginTop: 6 }}>
          <thead><tr><th style={{ width: 28 }}></th><th>Detail</th><th>On the shipment now</th><th>The email says</th></tr></thead>
          <tbody>{s.changes.map((c: any) => <tr key={c.key} className={c.old ? 'loss' : ''}>
            <td><input type="checkbox" style={{ width: 'auto' }} checked={!!v.on[c.key]} aria-label={`Save ${c.label}`} onChange={(x) => setE(s, { on: { ...v.on, [c.key]: x.target.checked } })} /></td>
            <td>{c.label}</td><td className="muted">{show(c.key, c.old)}</td>
            <td>{c.key === 'routing_type'
              ? <select value={v.val[c.key]} onChange={(x) => setE(s, { val: { ...v.val, [c.key]: x.target.value } })}><option value="direct">Direct</option><option value="via">Via / transshipment</option></select>
              : <input value={v.val[c.key]} type={['etd', 'eta', 'atd', 'ata'].includes(c.key) ? 'date' : 'text'} aria-label={c.label}
                  onChange={(x) => setE(s, { val: { ...v.val, [c.key]: x.target.value } })} />}</td></tr>)}</tbody></table></div>}
        {s.new_containers.length > 0 && <p className="small" style={{ margin: '6px 0' }}>Containers to add:{' '}
          {s.new_containers.map((k: any) => <label key={k.container_no} style={{ marginRight: 12, whiteSpace: 'nowrap' }}>
            <input type="checkbox" style={{ width: 'auto' }} checked={!!v.cont[k.container_no]} onChange={(x) => setE(s, { cont: { ...v.cont, [k.container_no]: x.target.checked } })} />{' '}
            <b>{k.container_no}</b>{k.size_type ? ` ${k.size_type}` : ''}{k.seal_no ? ` · seal ${k.seal_no}` : ''}</label>)}</p>}
        {d.first && !nothing && <p className="small muted" style={{ margin: '4px 0' }}>Saving this confirms the booking (the normal "Booking confirmed" step) — then the pre-alert is awaited.</p>}
        {!d.first && s.changes.some((c: any) => ['vessel_flight', 'voyage', 'etd', 'eta'].includes(c.key) && v.on[c.key]) &&
          <p className="small muted" style={{ margin: '4px 0' }}>The vessel / dates change: the team is told and the vessel details must be verified again.</p>}
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          {!nothing && <button className="btn small primary" onClick={() => save(s)}>Save booking</button>}
          <button className="btn small" onClick={() => act(s, { action: 'dismiss' })}>{nothing ? 'OK' : 'Dismiss'}</button></div>
      </div>; })}
      {(d.done ?? []).length > 0 && <details className="small" style={{ marginTop: 6 }}><summary>{d.done.length} booking email{d.done.length === 1 ? '' : 's'} already handled</summary>
        {d.done.map((s: any) => <p key={s.id} style={{ margin: '4px 0 0 12px' }}>{s.from_name || s.from_addr} · {fmtDateTime(s.sent_at)} — {s.summary}
          <b>{s.status === 'applied' ? ' · saved' : s.status === 'dismissed' ? ' · dismissed' : ' · nothing to save'}</b>{s.decided_by_name ? ` by ${s.decided_by_name}` : ''}</p>)}</details>}
      {!reading && d.unread.filter((m: any) => tried.current.has(m.id) || !d.configured).map((m: any) => <p key={m.id} className="small" style={{ margin: '4px 0' }}>
        Email from {m.from_name || m.from_addr} not read yet.{d.configured && <> <button className="linkish" onClick={() => read(m)}>Read with AI</button></>}</p>)}
    </div>
  );
}

/** 24 Nov: the Track buttons (the line's own page, where the vessel is), cut-offs, and Sailed / Arrived. */
export function TrackBox({ fileId, stamp }: { fileId: string; stamp?: unknown }) {
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [day, setDay] = useState<Record<string, string>>({});
  useEffect(() => { api(`/api/job-files/${fileId}/tracking`).then(setD).catch(() => setD(null)); }, [fileId, stamp]);
  if (!d || (!d.links.length && !d.can_mark)) return null;
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
  const mark = async (what: string, date: string) => {
    setErr('');
    try { setD(await api(`/api/job-files/${fileId}/tracking`, { body: { what, date } })); } catch (x: any) { setErr(x.message); }
  };
  const cut = [['SI / documents', d.cutoffs.si], ['VGM', d.cutoffs.vgm], ['Port / gate-in', d.cutoffs.gate]].filter(([, v]) => v);
  const late = d.etd && d.etd < today && !d.atd;
  return (
    <div className="panel"><h2>Track</h2>
      {err && <div className="msg err small">{err}</div>}
      {d.links.length > 0 ? <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {d.links.map((l: any) => <a key={l.url} className="btn small" href={l.url} target="_blank" rel="noopener noreferrer">{l.label} ↗</a>)}</div>
        : <p className="muted small" style={{ marginTop: 0 }}>The Track buttons show once there is a container, BL or booking no. and the line.</p>}
      {cut.length > 0 && <div className="small" style={{ margin: '8px 0 0' }}>{cut.map(([k, v]) => <div key={k}>{k} cut-off <b>{fmtDate(String(v).slice(0, 10))} {String(v).slice(11)}</b></div>)}</div>}
      {d.empty_pickup && <p className="small" style={{ margin: '4px 0 0' }}>Empty pick-up: {d.empty_pickup}</p>}
      {late && <p className="small" style={{ color: '#B7791F', margin: '8px 0 0' }}>ETD {fmtDate(d.etd)} has passed — confirm it sailed, or get the new ETD.</p>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 8 }}>
        {(['sailed', 'arrived'] as const).map((w) => { const has = w === 'sailed' ? d.atd : d.ata; const label = w === 'sailed' ? 'Sailed' : 'Arrived';
          return <div key={w} className="small">{has ? <>{label} on <b>{fmtDate(has)}</b>{d.can_mark && <> <button className="linkish" onClick={() => { if (confirm(`Take "${label}" off?`)) mark(w, ''); }}>undo</button></>}</>
            : d.can_mark && (w === 'sailed' || d.atd) ? <span style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input type="date" max={today} value={day[w] ?? today} onChange={(x) => setDay({ ...day, [w]: x.target.value })} aria-label={`${label} on`} style={{ width: 150 }} />
              <button className="btn small" onClick={() => mark(w, day[w] ?? today)}>{label}</button></span> : null}</div>; })}
      </div>
    </div>
  );
}
