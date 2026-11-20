'use client';
import { useEffect, useRef, useState } from 'react';
import { api } from './api';

let countriesCache: Promise<{ code: string; name: string }[]> | null = null;
export const loadCountries = () => (countriesCache ??= api('/api/countries').then((r) => r.rows).catch(() => { countriesCache = null; return []; }));

/** Country chooser (ISO code), from the world list. */
export function CountryPicker({ value, onChange, placeholder = 'Choose country' }: { value?: string | null; onChange: (code: string | null) => void; placeholder?: string }) {
  const [list, setList] = useState<{ code: string; name: string }[]>([]);
  useEffect(() => { loadCountries().then(setList); }, []);
  return <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
    <option value="">{placeholder}</option>
    {list.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}
    {value && !list.some((c) => c.code === value) && <option value={value}>{value}</option>}
  </select>;
}

/**
 * Port / airport box: type a name or code (Jebel Ali, AEJEA, DXB) and pick from the world list. The name is kept as typed text
 * too, so an old free-text port still shows; picking from the list also fills the code (and the country when it is empty).
 */
export function PortPicker({ name, code, kind, country, onChange }: {
  name?: string | null; code?: string | null; kind?: 'sea' | 'air' | null; country?: string | null;
  onChange: (v: { name: string; code: string | null; country_code?: string | null }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<any[]>([]);
  const [hi, setHi] = useState(0);
  const timer = useRef<any>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', h); return () => document.removeEventListener('mousedown', h);
  }, []);
  const search = (t: string) => {
    clearTimeout(timer.current);
    if (t.trim().length < 2) { setRows([]); return; }
    timer.current = setTimeout(() => api(`/api/ports?${new URLSearchParams({ q: t, ...(kind ? { kind } : {}), ...(country ? { country } : {}) })}`)
      .then((r) => { setRows(r.rows); setHi(0); setOpen(true); }).catch(() => setRows([])), 250);
  };
  const pick = (r: any) => { onChange({ name: r.name, code: r.code, country_code: r.country_code }); setOpen(false); };
  return (
    <div className="port-pick" ref={box}>
      <input value={name ?? ''} placeholder="Type a port, airport or code" role="combobox" aria-expanded={open} aria-autocomplete="list"
        onChange={(e) => { onChange({ name: e.target.value, code: null }); search(e.target.value); }}
        onFocus={() => rows.length && setOpen(true)}
        onKeyDown={(e) => {
          if (!open || !rows.length) return;
          if (e.key === 'ArrowDown') { e.preventDefault(); setHi((hi + 1) % rows.length); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setHi((hi - 1 + rows.length) % rows.length); }
          if (e.key === 'Enter') { e.preventDefault(); pick(rows[hi]); }
          if (e.key === 'Escape') setOpen(false);
        }} />
      {code && <span className="port-code" title="Chosen from the port list">{code}</span>}
      {open && rows.length > 0 && <div className="port-list" role="listbox">{rows.map((r, i) => (
        <button type="button" key={r.code} role="option" aria-selected={i === hi} className={i === hi ? 'on' : ''} onMouseEnter={() => setHi(i)} onMouseDown={(e) => { e.preventDefault(); pick(r); }}>
          <b>{r.name}</b> <span className="muted small">{r.country_name ?? r.country_code} · {r.code}{r.iata && r.iata !== r.code.slice(2) ? ` · ${r.iata}` : ''}{r.kind === 'air' ? ' · airport' : r.kind === 'both' ? ' · port & airport' : r.kind === 'inland' ? ' · inland' : ''}</span>
        </button>))}</div>}
      {open && rows.length === 0 && (name ?? '').trim().length >= 2 && <div className="port-list"><span className="muted small" style={{ padding: 8, display: 'block' }}>No port found — the name you typed is kept as it is.</span></div>}
    </div>
  );
}
