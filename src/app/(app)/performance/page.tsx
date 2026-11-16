'use client';
/** Release K step 9 — My performance: your own numbers for a period, with charts; Excel download and print / save as PDF. */
import { useEffect, useState } from 'react';
import { api, fmtMoney } from '@/components/api';
import { useMe } from '@/components/Shell';
import { CountChart } from '@/components/Charts';
import { period, PERIODS } from '@/lib/period';

const COLORS = ['#1E3A5F', '#2F7D55', '#E8A808'];
const LABELS: Record<string, string> = { jobs: 'Jobs', completed: 'Completed', total_cost: 'Cost', revenue: 'Revenue', net_revenue: 'Revenue', gross_profit: 'Profit', margin_pct: 'Margin %' };

export default function Performance() {
  const { me, lk } = useMe();
  const [pkey, setPkey] = useState('this_month');
  const [custom, setCustom] = useState<[string, string]>(period('this_month', lk.timezone));
  const [who, setWho] = useState('');
  const [d, setD] = useState<any>(null);
  const [err, setErr] = useState('');
  const [from, to] = pkey === 'custom' ? custom : period(pkey, lk.timezone);
  const qs = `from=${from}&to=${to}${who ? `&user_id=${who}` : ''}`;
  useEffect(() => { setErr(''); api(`/api/performance?${qs}`).then(setD).catch((e) => setErr(e.message)); }, [qs]);
  const cur = lk.currency ?? 'AED';
  const show = (c: any) => c.value === null || c.value === undefined ? '—' : c.money ? fmtMoney(String(c.value), cur) : c.value;
  return (
    <div className="page perf">
      <div className="page-head"><h1>{d && d.person.id !== me.id ? `Performance — ${d.person.name}` : 'My performance'}</h1><span className="spacer" />
        <a className="btn" href={`/api/performance?${qs}&format=xlsx`}>Download Excel</a>
        <button className="btn" onClick={() => window.print()}>Print / save as PDF</button></div>
      <div className="filter-row no-print">
        <select value={pkey} onChange={(e) => setPkey(e.target.value)} aria-label="Period">{PERIODS.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        {pkey === 'custom' && <>
          <input type="date" value={custom[0]} onChange={(e) => setCustom([e.target.value, custom[1]])} aria-label="From" />
          <input type="date" value={custom[1]} onChange={(e) => setCustom([custom[0], e.target.value])} aria-label="To" /></>}
        {d && d.people.length > 1 && <select value={who} onChange={(e) => setWho(e.target.value)} aria-label="Person">
          {d.people.map((u: any) => <option key={u.id} value={u.id === me.id ? '' : u.id}>{u.id === me.id ? `Me (${u.full_name})` : u.full_name}</option>)}</select>}
      </div>
      {err && <div className="msg err">{err}</div>}
      {!d ? <p className="muted">Loading…</p> : <>
        <p className="muted small" style={{ marginTop: 0 }}>
          {[d.person.designation, d.person.role, d.person.department].filter(Boolean).join(' · ')} · {d.person.kind_name} measures · {d.period.from} to {d.period.to}
        </p>
        <div className="perf-cards">{d.cards.map((c: any) => (
          <div key={c.key} className={`perf-card${c.tone ? ' ' + c.tone : ''}${c.key === 'reasons' ? ' wide' : ''}`}>
            <span className="muted small">{c.label}</span><b>{show(c)}</b>{c.hint && <span className="muted small">{c.hint}</span>}</div>))}</div>
        {d.lines.length > 0 && <div className="panel"><CountChart rows={d.series} unit={d.period.unit}
          series={d.lines.map((l: any, i: number) => ({ key: l.key, label: l.label, color: COLORS[i % COLORS.length] }))} /></div>}
        {d.department && <div className="panel"><h2 style={{ marginTop: 0 }}>Department — {d.department.label}</h2>
          <div className="perf-cards">{Object.entries(d.department).filter(([k]) => LABELS[k]).map(([k, v]: any) => (
            <div key={k} className="perf-card"><span className="muted small">{LABELS[k]}</span><b>{k === 'margin_pct' ? `${v ?? '—'}%` : ['jobs', 'completed'].includes(k) ? v : fmtMoney(String(v ?? 0), cur)}</b></div>))}</div></div>}
        {d.columns.length > 0 && <div className="panel flush"><div className="table-wrap"><table className="t">
          <thead><tr>{d.columns.map((c: any) => <th key={c.key}>{c.label}</th>)}</tr></thead>
          <tbody>{d.rows.map((r: any, i: number) => <tr key={i}>{d.columns.map((c: any) => <td key={c.key}>{['sell', 'profit'].includes(c.key) && r[c.key] !== null
            ? <span style={{ color: c.key === 'profit' && r[c.key] < 0 ? '#9B2C2C' : undefined }}>{fmtMoney(String(r[c.key]), cur)}</span> : r[c.key] ?? '—'}</td>)}</tr>)}
            {d.rows.length === 0 && <tr><td colSpan={d.columns.length} className="muted" style={{ padding: 20, textAlign: 'center' }}>Nothing in this period.</td></tr>}</tbody>
        </table></div></div>}
      </>}
    </div>
  );
}
