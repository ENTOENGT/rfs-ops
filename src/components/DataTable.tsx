'use client';
/**
 * The standard list table (Part E): column sorting (server side), pages, choose visible columns (remembered in this
 * browser), sticky header, row actions, and export of the current filter to CSV or Excel. Secondary details belong
 * on the detail page, not in extra columns.
 */
import Link from 'next/link';
import { ReactNode, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

export type RowAction = { label: string; href?: string; onClick?: () => void; danger?: boolean };
/** The "⋯" menu at the end of a row. */
function RowMenu({ items }: { items: RowAction[] }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const click = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', click); return () => document.removeEventListener('mousedown', click);
  }, [open]);
  if (!items.length) return null;
  return <div ref={ref} style={{ position: 'relative', display: 'inline-block' }}>
    <button className="icon-btn sm" aria-label="Actions" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="dots" /></button>
    {open && <div className="dropdown menu pop-right" role="menu">{items.map((a) => a.href
      ? <Link key={a.label} href={a.href} role="menuitem" onClick={() => setOpen(false)} style={a.danger ? { color: 'var(--danger)' } : undefined}>{a.label}</Link>
      : <button key={a.label} role="menuitem" onClick={() => { setOpen(false); a.onClick?.(); }} style={a.danger ? { color: 'var(--danger)' } : undefined}>{a.label}</button>)}</div>}
  </div>;
}

export type Col<T> = {
  key: string; label: string;
  render?: (r: T) => ReactNode;       // how the cell shows
  text?: (r: T) => string | number | null | undefined;   // the value exported (defaults to r[key])
  sort?: string;                      // server sort key; omit = not sortable
  num?: boolean; width?: number;
  hidden?: boolean;                   // hidden until the person turns it on
  always?: boolean;                   // can't be hidden
};

export function DataTable<T extends { id: string }>({ id, cols, rows, total, page, pageSize, sort, dir, onSort, onPage, empty = 'Nothing here.',
  rowClass, exportAll, exportName, actions, title }: {
  id: string; cols: Col<T>[]; rows: T[] | null; total: number; page: number; pageSize: number;
  sort?: string; dir?: 'asc' | 'desc'; onSort?: (key: string, dir: 'asc' | 'desc') => void; onPage: (p: number) => void;
  empty?: string; rowClass?: (r: T) => string; exportAll?: () => Promise<T[]>; exportName?: string;
  /** the row's "⋯" menu (UI redesign) */ actions?: (r: T) => RowAction[]; title?: string;
}) {
  const [shown, setShown] = useState<string[] | null>(null);
  const [pick, setPick] = useState(false);
  const [busy, setBusy] = useState('');
  useEffect(() => {
    try { const s = localStorage.getItem(`cols.${id}`); if (s) { setShown(JSON.parse(s)); return; } } catch { /* no storage */ }
    setShown(cols.filter((c) => !c.hidden).map((c) => c.key));
  }, [id]);  // eslint-disable-line react-hooks/exhaustive-deps
  const visible = cols.filter((c) => c.always || (shown ?? cols.filter((x) => !x.hidden).map((x) => x.key)).includes(c.key));
  const toggle = (k: string) => {
    const base = shown ?? cols.filter((c) => !c.hidden).map((c) => c.key);
    const n = base.includes(k) ? base.filter((x) => x !== k) : [...base, k];
    setShown(n);
    try { localStorage.setItem(`cols.${id}`, JSON.stringify(n)); } catch { /* no storage */ }
  };
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const val = (c: Col<T>, r: T) => { const v = c.text ? c.text(r) : (r as any)[c.key]; return v === null || v === undefined ? '' : v; };
  const download = async (kind: 'csv' | 'xlsx') => {
    if (!exportAll) return;
    setBusy(kind);
    try {
      const all = await exportAll();
      const name = `${exportName ?? id}-${new Date().toISOString().slice(0, 10)}`;
      let blob: Blob;
      if (kind === 'csv') {
        const esc = (v: unknown) => { const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
        const text = [visible.map((c) => esc(c.label)).join(','), ...all.map((r) => visible.map((c) => esc(val(c, r))).join(','))].join('\r\n');
        blob = new Blob(['﻿' + text], { type: 'text/csv;charset=utf-8' });
      } else {
        const ExcelJS = (await import('exceljs')).default;
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('List');
        ws.columns = visible.map((c) => ({ header: c.label, key: c.key, width: Math.max(10, Math.min(40, (c.width ?? 120) / 7)) }));
        for (const r of all) ws.addRow(Object.fromEntries(visible.map((c) => { const v = val(c, r); return [c.key, c.num && v !== '' ? Number(v) : v]; })));
        ws.getRow(1).font = { bold: true };
        ws.views = [{ state: 'frozen', ySplit: 1 }];
        blob = new Blob([await wb.xlsx.writeBuffer()], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = `${name}.${kind}`; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } finally { setBusy(''); }
  };
  return (
    <div className="panel flush dt">
      <div className="dt-bar">
        {title && <b style={{ fontSize: 14 }}>{title}</b>}
        <span className="muted small">{rows ? `${total.toLocaleString()} ${total === 1 ? 'record' : 'records'}` : 'Loading…'}</span>
        <span className="spacer" />
        {exportAll && <><button className="btn small" disabled={!!busy || !total} onClick={() => download('xlsx')}>{busy === 'xlsx' ? 'Preparing…' : 'Export Excel'}</button>
          <button className="btn small" disabled={!!busy || !total} onClick={() => download('csv')}>{busy === 'csv' ? 'Preparing…' : 'CSV'}</button></>}
        <span className="dt-cols"><button className="btn small" onClick={() => setPick(!pick)} aria-expanded={pick}><Icon name="panel" size={15} />Columns</button>
          {pick && <div className="dt-pick" role="dialog" aria-label="Choose columns">
            {cols.filter((c) => !c.always).map((c) => <label key={c.key} className="check">
              <input type="checkbox" checked={visible.some((v) => v.key === c.key)} onChange={() => toggle(c.key)} /> {c.label}</label>)}
            <button className="linkish small" onClick={() => setPick(false)}>Done</button></div>}</span>
      </div>
      <div className="table-wrap dt-wrap"><table className="t sticky">
        <thead><tr>{visible.map((c) => {
          const on = sort === c.sort && !!c.sort;
          return <th key={c.key} className={c.num ? 'num' : ''} style={c.width ? { minWidth: c.width } : undefined}
            aria-sort={on ? (dir === 'desc' ? 'descending' : 'ascending') : undefined}>
            {c.sort && onSort ? <button className="dt-sort" onClick={() => onSort(c.sort!, on && dir === 'asc' ? 'desc' : 'asc')}>
              {c.label}<span aria-hidden>{on ? (dir === 'desc' ? ' ▼' : ' ▲') : ''}</span></button> : c.label}</th>;
        })}{actions && <th className="dt-act"><span className="sr-only">Actions</span></th>}</tr></thead>
        <tbody>
          {rows?.map((r) => <tr key={r.id} className={rowClass?.(r) ?? ''}>{visible.map((c) => <td key={c.key} className={c.num ? 'num' : ''}>{c.render ? c.render(r) : String(val(c, r) || '—')}</td>)}
            {actions && <td className="dt-act"><RowMenu items={actions(r)} /></td>}</tr>)}
          {rows && rows.length === 0 && <tr><td colSpan={visible.length + (actions ? 1 : 0)} className="muted" style={{ padding: 36, textAlign: 'center' }}>{empty}</td></tr>}
        </tbody></table></div>
      <div className="pager"><span>{rows && total > 0 ? `${(page - 1) * pageSize + 1}–${Math.min(total, page * pageSize)} of ${total.toLocaleString()}` : ''}</span><span className="spacer" />
        <button className="btn small" disabled={page <= 1} onClick={() => onPage(page - 1)}>Previous</button>
        <span>Page {page} of {pages}</span>
        <button className="btn small" disabled={page >= pages} onClick={() => onPage(page + 1)}>Next</button></div>
    </div>
  );
}
