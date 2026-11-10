/**
 * Global search (UI redesign): one box in the header finds shipments (Enquiry Ref, Shipping Ref, Job No., booking ref,
 * BL / AWB, container, customer, saved email subject), quotations, consolidations, transport jobs, customers and agents.
 * Every group goes through the same permission scope as its own list page, so nobody finds what they can't open.
 */
import { Actor } from './auth';
import { q } from './db';

type Row = { title: string; sub: string; href: string; tag?: string };
const safe = async <T,>(f: () => Promise<T>): Promise<T | null> => { try { return await f(); } catch { return null; } };

export async function globalSearch(actor: Actor, p: Record<string, string>) {
  const term = String(p.q ?? '').trim().slice(0, 80);
  if (term.length < 2) return { q: term, groups: [] };
  const like = '%' + term.toLowerCase().replace(/[%_\\]/g, '\\$&') + '%';
  const groups: { key: string; label: string; rows: Row[] }[] = [];

  const jf = await import('./jobfiles');
  if (jf.canSeeJobFiles(actor)) {
    const params: unknown[] = [like];
    const scope = jf.jfScope(actor, params);
    const rows = await q(`select f.id, f.enquiry_ref, f.shipping_ref, f.job_no, f.stage, f.status, f.origin, f.destination, f.port_of_loading, f.port_of_discharge, c.name customer_name,
        case when f.search_text like $1 then null
             when lower(coalesce(f.final_bl_no, '')) like $1 or exists (select 1 from bl_drafts b where b.job_file_id = f.id and lower(coalesce(b.bl_no, '')) like $1) then 'BL'
             when exists (select 1 from email_messages e where e.job_file_id = f.id and lower(coalesce(e.subject, '')) like $1) then 'Email' end matched
      from job_files f join customers c on c.id = f.customer_id
      where f.deleted_at is null ${scope} and (f.search_text like $1 or lower(coalesce(f.final_bl_no, '')) like $1
        or exists (select 1 from bl_drafts b where b.job_file_id = f.id and lower(coalesce(b.bl_no, '')) like $1)
        or exists (select 1 from email_messages e where e.job_file_id = f.id and lower(coalesce(e.subject, '')) like $1))
      order by f.updated_at desc limit 8`, params);
    const { stageName } = await import('../lib/commercialRules');
    groups.push({ key: 'shipments', label: 'Shipments', rows: rows.map((r) => ({
      title: [r.job_no && r.job_no !== r.enquiry_ref ? r.job_no : null, r.shipping_ref, r.enquiry_ref].filter(Boolean).join(' · ') || 'Shipment',
      sub: [r.customer_name, [r.port_of_loading ?? r.origin, r.port_of_discharge ?? r.destination].filter(Boolean).join(' → ')].filter(Boolean).join(' — '),
      href: `/job-files/${r.id}`, tag: r.matched ?? (r.stage ? stageName(r.stage) : r.status) })) });
  }
  if (actor.has('quotes.view')) {
    const r = await safe(async () => (await import('./quotations')).listQuotations(actor, { q: term, page_size: '5' }));
    if (r) groups.push({ key: 'quotations', label: 'Quotations', rows: r.rows.map((x: any) => ({
      title: `${x.quote_no}${x.version_no > 1 ? ` v${x.version_no}` : ''}`, sub: [x.customer_name, [x.origin, x.destination].filter(Boolean).join(' → ')].filter(Boolean).join(' — '),
      href: `/quotations/${x.id}`, tag: x.status_name })) });
  }
  const lcl = await safe(async () => (await import('./lcl')).listConsolidations(actor, { q: term, view: 'all', page_size: '5' }));
  if (lcl) groups.push({ key: 'lcl', label: 'Consolidations', rows: lcl.rows.map((x: any) => ({
    title: x.con_ref, sub: [x.container_no, x.mbl_no && `MBL ${x.mbl_no}`, [x.pol, x.pod].filter(Boolean).join(' → ')].filter(Boolean).join(' · '), href: `/lcl/${x.id}`, tag: x.status_name })) });
  if (actor.has('jobs.view')) {
    const j = await safe(async () => (await import('./jobs')).listJobs(actor, { q: term, page_size: '5' }));
    if (j) groups.push({ key: 'jobs', label: 'Transport jobs', rows: (j as any).rows.map((x: any) => ({
      title: x.job_number ?? x.job_no ?? 'Job', sub: [x.customer_name, x.boe_number && `BOE ${x.boe_number}`].filter(Boolean).join(' · '), href: `/jobs/${x.id}`, tag: x.status_name })) });
  }
  const m = await import('./masters');
  const cust = await safe(() => m.listMaster(actor, 'customers', { q: term, page_size: '5' }));
  if (cust) groups.push({ key: 'customers', label: 'Customers', rows: (cust as any).rows.map((x: any) => ({ title: x.name, sub: [x.email, x.phone].filter(Boolean).join(' · '), href: `/customers?q=${encodeURIComponent(x.name)}` })) });
  if (actor.has('vendors.manage') || actor.has('vendors.requests')) {
    const v = await safe(() => m.listMaster(actor, 'vendors', { q: term, page_size: '5' }));
    if (v) groups.push({ key: 'vendors', label: 'Agents and vendors', rows: (v as any).rows.map((x: any) => ({ title: x.name, sub: [x.vendor_type_name ?? x.vendor_type, x.email].filter(Boolean).join(' · '),
      href: actor.has('vendors.manage') ? `/vendors?q=${encodeURIComponent(x.name)}` : `/vendor-requests?q=${encodeURIComponent(x.name)}` })) });
  }
  return { q: term, groups };
}
