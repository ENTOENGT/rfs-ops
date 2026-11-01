'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { api } from './api';

export const COND: Record<string, string> = { good: 'Good', damaged: 'Damaged', quarantine: 'Quarantine' };
export const ORDER_STATUS: Record<string, [string, string]> = {
  open: ['Waiting for stock', '#5B6B82'], reserved: ['Stock reserved', '#2B6CB0'], picked: ['Picked', '#553C9A'],
  packed: ['Packed', '#B7791F'], dispatched: ['Dispatched', '#22543D'], cancelled: ['Cancelled', '#9B2C2C'],
};
export const GRN_STATUS: Record<string, [string, string]> = { expected: ['Expected', '#B7791F'], received: ['Received', '#22543D'], cancelled: ['Cancelled', '#9B2C2C'] };
export const qtyFmt = (v: any) => (v == null ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 3 }));

/** Tabs across every warehouse page. */
export function WhTabs() {
  const path = usePathname();
  const tabs: [string, string][] = [['/warehouse', 'Stock'], ['/warehouse/receipts', 'Receipts (GRN)'], ['/warehouse/orders', 'Outbound orders'], ['/warehouse/setup', 'Setup']];
  const on = (h: string) => (h === '/warehouse' ? path === '/warehouse' : path.startsWith(h));
  return <div className="tabs">{tabs.map(([h, l]) => <Link key={h} href={h} style={{ textDecoration: 'none' }}>
    <button className={on(h) ? 'on' : ''} tabIndex={-1}>{l}</button></Link>)}</div>;
}

/** Warehouses and bins (shared by every page that needs to pick one). */
export function useWhConfig() {
  const [cfg, setCfg] = useState<any>(null);
  const reload = () => api('/api/warehouse?view=config').then(setCfg).catch(() => {});
  useEffect(() => { reload(); }, []);
  return { cfg, reload };
}
/** Active SKUs of one customer. */
export function useSkus(customerId?: string) {
  const [skus, setSkus] = useState<any[]>([]);
  useEffect(() => { if (!customerId) { setSkus([]); return; } api(`/api/warehouse?view=skus&customer_id=${customerId}`).then(setSkus).catch(() => setSkus([])); }, [customerId]);
  return skus;
}
