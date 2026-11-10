/**
 * The application's navigation (UI redesign). The primary sidebar shows only the modules; the secondary panel shows the
 * selected module's pages, grouped. Every link keeps the URL it had before. People see only the modules and pages their
 * role allows — the server checks every request again.
 */
export type Perm = string | string[];
export type NavItem = { href: string; label: string; perm?: Perm; section?: string };
export type NavModule = { key: string; label: string; icon: string; perm?: Perm; items: NavItem[]; /** other URLs that belong here */ paths?: string[] };

const COMMERCIAL = ['jobfiles.view_assigned', 'jobfiles.view_all', 'quotes.view', 'commercial.manage'];
const LCL = ['lcl.view', 'lcl.manage', 'lcl.receive', 'lcl.stuff'];
const WAREHOUSE = ['warehouse.view', 'warehouse.receive', 'warehouse.dispatch', 'warehouse.configure', 'warehouse.orders.create'];

export const MODULES: NavModule[] = [
  { key: 'dashboard', label: 'Dashboard', icon: 'dashboard', items: [{ href: '/dashboard', label: 'Dashboard' }], paths: ['/notifications'] },
  { key: 'commercials', label: 'Commercials', icon: 'briefcase', perm: [...COMMERCIAL, 'templates.manage'], items: [
    { href: '/commercials', label: 'Overview', perm: COMMERCIAL },
    { href: '/commercials?division=imports', label: 'Imports', section: 'Divisions', perm: COMMERCIAL },
    { href: '/commercials?division=exports', label: 'Exports', section: 'Divisions', perm: COMMERCIAL },
    { href: '/commercials?division=cross_trade', label: 'Cross Trade', section: 'Divisions', perm: COMMERCIAL },
    { href: '/settings/quote-terms', label: 'Quotation terms', section: 'Templates', perm: 'templates.manage' },
    { href: '/settings/email-templates', label: 'Email templates', section: 'Templates', perm: 'templates.manage' }] },
  { key: 'enquiries', label: 'Enquiries', icon: 'inbox', perm: COMMERCIAL, items: [
    { href: '/commercials/enquiries', label: 'All enquiries' },
    { href: '/commercials/enquiries?mine=1', label: 'My enquiries' },
    { href: '/commercials/enquiries?assigned=1', label: 'Assigned to me' },
    { href: '/job-files/new', label: 'New enquiry', perm: 'jobfiles.create', section: 'Create' }] },
  { key: 'rates', label: 'Rates', icon: 'scale', perm: ['vendors.requests', 'vendors.manage', 'rates.agent_coordination'], items: [
    { href: '/vendor-requests?service=rate&rate_source=overseas_agent', label: 'Agent rate requests' },
    { href: '/vendor-requests?service=rate&rate_source=agent_coordinator', label: 'Via Agent Coordinator' },
    { href: '/vendor-requests?mine=assigned&status=requested', label: 'Assigned to me', perm: 'rates.agent_coordination' },
    { href: '/vendor-requests?service=rate&rate_source=shipping_line', label: 'Direct liner rates', section: 'Direct carriers' },
    { href: '/vendor-requests?service=rate&rate_source=airline', label: 'Direct airline rates', section: 'Direct carriers' },
    { href: '/commercials/enquiries?view=c_quoting', label: 'Rate comparison', perm: COMMERCIAL, section: 'Compare' }] },
  { key: 'quotations', label: 'Quotations', icon: 'quote', perm: 'quotes.view', items: [
    { href: '/quotations?status=open', label: 'Open quotations' },
    { href: '/quotations?status=pending_approval&my_approval=1', label: 'Waiting for my approval', perm: 'quotes.salesman_approve' },
    { href: '/quotations?status=draft', label: 'Draft', section: 'By status' },
    { href: '/quotations?status=pending_approval', label: 'Pending approval', section: 'By status' },
    { href: '/quotations?status=approved', label: 'Approved', section: 'By status' },
    { href: '/quotations?status=sent', label: 'Sent to customer', section: 'By status' },
    { href: '/quotations?status=confirmed', label: 'Customer confirmed', section: 'By status' },
    { href: '/quotations?status=closed_out', label: 'Rejected / expired', section: 'By status' },
    { href: '/quotations/new', label: 'New quotation', perm: 'quotes.create', section: 'Create' }], paths: ['/quotations'] },
  { key: 'bookings', label: 'Bookings', icon: 'calendar', perm: COMMERCIAL, items: [
    { href: '/commercials/enquiries?view=c_confirmed', label: 'To book' },
    { href: '/commercials/enquiries?view=c_booking', label: 'Booking confirmation' },
    { href: '/vendor-requests?service=booking&status=open', label: 'Pending follow-ups' },
    { href: '/commercials/enquiries?view=c_vessel_pending', label: 'Vessel details pending', section: 'Vessel and BL' },
    { href: '/commercials/enquiries?view=c_bl_customer', label: 'BL drafts with customers', section: 'Vessel and BL' },
    { href: '/commercials/enquiries?view=c_bl_correction', label: 'BL corrections', section: 'Vessel and BL' }] },
  { key: 'lcl', label: 'LCL Management', icon: 'boxes', perm: LCL, items: [
    { href: '/lcl', label: 'Consolidation register' },
    { href: '/lcl/new', label: 'Create consolidation', perm: 'lcl.manage' },
    { href: '/lcl/shipments', label: 'House shipments', section: 'Registers' },
    { href: '/lcl/reports?r=mbl_register', label: 'Master BL register', section: 'Registers' },
    { href: '/lcl/shipments?view=hbl', label: 'House BL register', section: 'Registers' },
    { href: '/lcl?view=in_transit', label: 'Container monitoring', section: 'Cargo' },
    { href: '/lcl/shipments?view=pending_receiving', label: 'Cargo receiving', section: 'Cargo' },
    { href: '/lcl?view=stuffing', label: 'Stuffing and dispatch', section: 'Cargo' },
    { href: '/lcl/reports', label: 'LCL reports', section: 'Reports' }], paths: ['/lcl'] },
  { key: 'prealerts', label: 'Pre-alerts', icon: 'mail', perm: COMMERCIAL, items: [
    { href: '/commercials/enquiries?view=c_prealert', label: 'Awaiting pre-alert' },
    { href: '/commercials/enquiries?view=c_prealert_received', label: 'Pre-alert to verify' },
    { href: '/commercials/enquiries?view=c_awaiting_job', label: 'Awaiting job creation', section: 'Handover' },
    { href: '/commercials/enquiries?view=c_handed_over', label: 'Handed over to Operations', section: 'Handover' }] },
  { key: 'operations', label: 'Operations', icon: 'anchor', items: [
    { href: '/job-files', label: 'Job Files', perm: ['jobfiles.view_all', 'jobfiles.view_department', 'jobfiles.view_handed_over', 'jobfiles.edit'] },
    { href: '/vendor-requests', label: 'Vendor requests', perm: ['vendors.requests', 'vendors.manage'] },
    { href: '/pro', label: 'PRO clearance', perm: ['pro.view_all', 'pro.view_department', 'pro.create', 'pro.update', 'pro.assign'], section: 'Services' },
    { href: '/runs', label: 'Messenger runs', perm: ['runs.view_all', 'runs.view_department', 'runs.create', 'runs.update_status'], section: 'Services' }],
    paths: ['/job-files', '/vendor-requests', '/pro', '/runs', '/cases'] },
  { key: 'warehouse', label: 'Warehouse', icon: 'warehouse', perm: WAREHOUSE, items: [
    { href: '/warehouse', label: 'Stock on hand' },
    { href: '/warehouse/receipts', label: 'Goods receipts', perm: ['warehouse.view', 'warehouse.receive'] },
    { href: '/warehouse/orders', label: 'Orders and dispatch', perm: ['warehouse.view', 'warehouse.dispatch', 'warehouse.orders.create'] },
    { href: '/warehouse/setup', label: 'Warehouses and bins', perm: 'warehouse.configure', section: 'Setup' }], paths: ['/warehouse'] },
  { key: 'transport', label: 'Transport', icon: 'truck', items: [
    { href: '/requests', label: 'Transport requests', perm: 'jobs.view' },
    { href: '/jobs', label: 'Jobs', perm: 'jobs.view' },
    { href: '/drivers', label: 'Drivers', perm: 'jobs.view', section: 'Fleet' },
    { href: '/vehicles', label: 'Vehicles', perm: 'jobs.view', section: 'Fleet' },
    { href: '/subcontractors', label: 'Rental companies', perm: 'vehicles.manage', section: 'Fleet' },
    { href: '/rental_rates', label: 'Rental rates', perm: 'vehicles.manage', section: 'Fleet' },
    { href: '/locations', label: 'Locations', perm: 'jobs.view', section: 'Lists' }], paths: ['/requests', '/jobs'] },
  { key: 'documents', label: 'Documents', icon: 'folder', items: [
    { href: '/documents', label: 'Transport documents', perm: 'jobs.view' }] },
  { key: 'reports', label: 'Reports', icon: 'chart', items: [
    { href: '/reports', label: 'Reports', perm: 'reports.view' },
    { href: '/financials', label: 'Financials', perm: ['finance.buying.view', 'finance.selling.view'] },
    { href: '/lcl/reports', label: 'LCL reports', perm: LCL },
    { href: '/erp', label: 'ERP export', perm: ['erp.view', 'erp.export'], section: 'ERP' }], paths: ['/reports', '/financials', '/erp'] },
  { key: 'admin', label: 'Administration', icon: 'shield', items: [
    { href: '/users', label: 'Users', perm: ['users.manage', 'users.manage_department'] },
    { href: '/roles', label: 'Roles & permissions', perm: ['roles.manage', 'roles.manage_department'] },
    { href: '/settings', label: 'Settings', perm: 'settings.manage' },
    { href: '/customers', label: 'Customers', perm: ['jobs.view', 'customers.manage'], section: 'Master data' },
    { href: '/vendors', label: 'Vendors', perm: 'vendors.manage', section: 'Master data' }], paths: ['/users', '/roles', '/settings', '/customers', '/vendors'] },
];
// shipment records opened from these modules stay under the module they were opened from
for (const m of MODULES) if (['commercials', 'enquiries', 'bookings', 'prealerts'].includes(m.key)) m.paths = [...(m.paths ?? []), '/job-files'];

/** "+ New" in the header. */
export const QUICK_CREATE: { href: string; label: string; perm: string }[] = [
  { href: '/job-files/new', label: 'New enquiry', perm: 'jobfiles.create' },
  { href: '/quotations/new', label: 'New quotation', perm: 'quotes.create' },
  { href: '/lcl/new', label: 'New consolidation', perm: 'lcl.manage' },
  { href: '/requests/new', label: 'Transport request', perm: 'jobs.create' },
  { href: '/runs/new', label: 'Messenger run', perm: 'runs.create' },
  { href: '/pro/new', label: 'PRO request', perm: 'pro.create' },
  { href: '/warehouse/receipts/new', label: 'Goods receipt', perm: 'warehouse.receive' },
  { href: '/warehouse/orders/new', label: 'Warehouse order', perm: 'warehouse.orders.create' },
];

export const allowedBy = (can: (p: string) => boolean, p?: Perm) => !p || (Array.isArray(p) ? p.some(can) : can(p));

/** The modules (and their pages) this person may see. */
export function visibleModules(can: (p: string) => boolean, opts: { moneyScreens?: boolean } = {}) {
  return MODULES.filter((m) => allowedBy(can, m.perm))
    .map((m) => ({ ...m, items: m.items.filter((i) => allowedBy(can, i.perm) && (i.href !== '/financials' || opts.moneyScreens !== false)) }))
    .filter((m) => m.items.length);
}

/** Is this link the page being shown? Query links must match exactly; plain links also cover their sub-pages. */
export function isOn(href: string, path: string, search: string, all: string[]) {
  const here = path + (search ? `?${search}` : '');
  if (href.includes('?')) {
    if (here === href) return true;
    // a bare list URL (/quotations) counts as the module's first filtered view of that list, unless a plain link exists for it
    return !search && href.split('?')[0] === path && !all.includes(path) && all.find((h) => h.startsWith(path + '?')) === href;
  }
  if (path === href) return !all.some((h) => h.startsWith(href + '?') && here === h);
  return path.startsWith(href + '/') && !all.some((h) => h !== href && !h.includes('?') && h.startsWith(href + '/') && path.startsWith(h));
}

/** The module and page for the current URL. `prefer` keeps the module the person opened when a page belongs to several. */
export function locate(mods: NavModule[], path: string, search: string, prefer?: string | null) {
  const all = mods.flatMap((m) => m.items.map((i) => i.href));
  const owns = (m: NavModule) => [...(m.paths ?? []), ...m.items.map((i) => i.href.split('?')[0])].some((p) => p !== '/' && (path === p || path.startsWith(p + '/')));
  const pm = prefer ? mods.find((x) => x.key === prefer) : undefined;
  if (pm) {
    const it = pm.items.find((i) => isOn(i.href, path, search, all)); if (it) return { mod: pm, item: it, exact: true };
    // a record opened from this module (an enquiry opened from Enquiries) keeps this module selected
    if (owns(pm) && !path.endsWith('/new')) return { mod: pm, item: null, exact: false };
  }
  for (const m of mods) { const it = m.items.find((i) => isOn(i.href, path, search, all)); if (it) return { mod: m, item: it, exact: true }; }
  for (const m of mods) if (owns(m)) return { mod: m, item: null, exact: false };
  return { mod: null, item: null, exact: false };
}
