/**
 * Role dashboard (UI redesign). Every figure is a count of real records the person may see — the same scope as the lists
 * the cards open. Commercials Manager, Coordinator, Salesman, Agent Coordinator, Warehouse and Operations each get their
 * own cards; a person with several jobs gets each relevant set. No sample numbers.
 */
import { Actor } from './auth';
import { one, q } from './db';

type Card = { key: string; label: string; count: number; href: string; icon: string; tone?: 'warn' | 'danger' | 'ok' | 'teal'; hint?: string };
type Section = { key: string; title: string; cards: Card[] };
const enq = (view: string, extra = '') => `/commercials/enquiries?view=${view}${extra}`;

export async function homeDashboard(actor: Actor) {
  const jf = await import('./jobfiles');
  const sections: Section[] = [];
  const role = actor.role_code;
  const commercialSeer = jf.canSeeJobFiles(actor) && (actor.has('jobfiles.view_assigned') || actor.has('commercial.manage') || actor.has('jobfiles.view_all') || actor.has('quotes.view'));
  let tasks: any[] = [];
  let weekly: { week: string; count: number }[] = [];
  let pipeline: { key: string; label: string; count: number }[] = [];

  if (commercialSeer) {
    const params: unknown[] = [];
    const scope = jf.jfScope(actor, params);
    const V = jf.COMMERCIAL_VIEWS;
    const mineClause = (col: string) => { params.push(actor.id); return `f.${col} = $${params.length}`; };
    const asCoord = role === 'coordinator', asSales = role === 'sales';
    const me = asCoord ? mineClause('coordinator_id') : asSales ? mineClause('salesman_id') : 'true';
    const base = `from job_files f where f.deleted_at is null and (${V.c_all})${scope}`;
    const c = await one(`select
        count(*) filter (where ${V.c_open})::int open, count(*) filter (where ${V.c_open} and ${me})::int my_open,
        count(*) filter (where ${V.c_rates})::int rates, count(*) filter (where ${V.c_quoting})::int quoting, count(*) filter (where ${V.c_pending_quotes})::int pending_quotes,
        count(*) filter (where ${V.c_approval})::int approval, count(*) filter (where ${V.c_sent})::int sent, count(*) filter (where ${V.c_confirmed})::int confirmed,
        count(*) filter (where ${V.c_booking})::int booking, count(*) filter (where ${V.c_prealert})::int prealert, count(*) filter (where ${V.c_awaiting_job})::int awaiting_job,
        count(*) filter (where ${V.c_vessel_pending})::int vessel, count(*) filter (where ${V.c_bl_customer})::int bl_customer, count(*) filter (where ${V.c_bl_correction})::int bl_correction,
        count(*) filter (where ${V.c_cust_pending})::int cust_pending, count(*) filter (where ${V.c_active})::int active, count(*) filter (where ${V.c_enquiry})::int new_enq,
        count(*) filter (where f.created_at >= date_trunc('month', now() at time zone 'Asia/Dubai'))::int this_month
      ${base}`, params);
    const quotes = actor.has('quotes.view') ? (await (await import('./quotations')).listQuotations(actor, { status: 'open', page_size: '1' })).total : 0;
    const myApprovals = (await one(`select count(*)::int n from quotations x where x.status = 'pending_approval' and x.deleted_at is null and x.salesman_id = $1 and x.salesman_decision is null`, [actor.id])).n;
    const assigned = asCoord || asSales ? '&assigned=1' : '';
    if (role === 'commercials_manager' || actor.isSuperAdmin || (actor.has('commercial.manage') && !asCoord && !asSales)) {
      sections.push({ key: 'manager', title: 'Commercials', cards: [
        { key: 'total', label: 'Open enquiries', count: c.open, href: enq('c_open'), icon: 'inbox', hint: `${c.this_month} opened this month` },
        { key: 'quotes', label: 'Open quotations', count: quotes, href: '/quotations?status=open', icon: 'quote' },
        { key: 'approvals', label: 'Pending approvals', count: c.approval, href: enq('c_approval'), icon: 'clock', tone: 'warn' },
        { key: 'confirmed', label: 'Confirmed shipments', count: c.confirmed, href: enq('c_confirmed'), icon: 'ship', tone: 'ok', hint: 'Customer confirmed, to book' },
        { key: 'bookings', label: 'Pending bookings', count: c.booking, href: enq('c_booking'), icon: 'calendar' },
        { key: 'bl', label: 'BL drafts with customers', count: c.bl_customer, href: enq('c_bl_customer'), icon: 'quote', tone: 'teal' },
        { key: 'prealert', label: 'Pre-alerts pending', count: c.prealert, href: enq('c_prealert'), icon: 'mail' },
        { key: 'handover', label: 'Jobs awaiting handover', count: c.awaiting_job, href: enq('c_awaiting_job'), icon: 'arrowRight', tone: 'warn' },
      ] });
    } else if (asCoord) {
      sections.push({ key: 'coordinator', title: 'My enquiries and shipments', cards: [
        { key: 'mine', label: 'My assigned enquiries', count: c.my_open, href: enq('c_open', assigned), icon: 'inbox' },
        { key: 'rates', label: 'Pending agent rates', count: c.rates, href: enq('c_rates', assigned), icon: 'scale' },
        { key: 'prepare', label: 'Quotations to prepare', count: c.quoting, href: enq('c_quoting', assigned), icon: 'quote', tone: 'warn' },
        { key: 'followups', label: 'Customer follow-ups', count: c.sent, href: enq('c_sent', assigned), icon: 'mail' },
        { key: 'booking', label: 'Booking follow-ups', count: c.booking + c.confirmed, href: enq('c_booking', assigned), icon: 'calendar', hint: `${c.confirmed} to book, ${c.booking} awaiting confirmation` },
        { key: 'vessel', label: 'Vessel details pending', count: c.vessel, href: enq('c_vessel_pending', assigned), icon: 'ship' },
        { key: 'blfix', label: 'BL draft corrections', count: c.bl_correction, href: enq('c_bl_correction', assigned), icon: 'alert', tone: 'danger' },
        { key: 'custconf', label: 'Pending customer confirmations', count: c.cust_pending, href: enq('c_cust_pending', assigned), icon: 'clock', tone: 'teal' },
      ] });
    } else if (asSales) {
      sections.push({ key: 'sales', title: "My customers' shipments", cards: [
        { key: 'mine', label: 'My enquiries', count: c.my_open, href: enq('c_open', assigned), icon: 'inbox' },
        { key: 'pending', label: 'Pending quotations', count: c.pending_quotes, href: enq('c_pending_quotes', assigned), icon: 'quote' },
        { key: 'approvals', label: 'Approvals required', count: myApprovals, href: '/quotations?status=pending_approval&my_approval=1', icon: 'clock', tone: 'warn' },
        { key: 'custconf', label: 'Customer confirmations', count: c.sent, href: enq('c_sent', assigned), icon: 'mail', tone: 'teal' },
        { key: 'active', label: 'Active shipments', count: c.active, href: enq('c_active', assigned), icon: 'ship', tone: 'ok' },
      ] });
    }
    // what needs a hand first
    const urgent = asSales ? ['c_approval', 'c_sent', 'c_confirmed'] : asCoord ? ['c_bl_correction', 'c_quoting', 'c_confirmed', 'c_prealert_received', 'c_awaiting_job', 'c_rates']
      : ['c_approval', 'c_awaiting_job', 'c_confirmed', 'c_bl_correction', 'c_prealert_received'];
    const tp: unknown[] = [];
    const tscope = jf.jfScope(actor, tp);
    tp.push(actor.id);
    const meT = asCoord ? `f.coordinator_id = $${tp.length}` : asSales ? `f.salesman_id = $${tp.length}` : `$${tp.length}::uuid is not null`;
    tasks = await q(`select f.id, f.enquiry_ref, f.shipping_ref, f.job_no, f.stage, f.bl_status, f.updated_at, c.name customer_name, f.origin, f.destination,
        f.port_of_loading, f.port_of_discharge, case ${urgent.map((v, i) => `when ${V[v]} then ${i}`).join(' ')} end prio,
        case ${urgent.map((v) => `when ${V[v]} then '${v}'`).join(' ')} end why
      from job_files f join customers c on c.id = f.customer_id
      where f.deleted_at is null${tscope} and (${urgent.map((v) => `(${V[v]})`).join(' or ')}) and ${meT}
      order by prio, f.updated_at limit 8`, tp);
    const wp: unknown[] = [];
    const wscope = jf.jfScope(actor, wp);
    weekly = await q(`select to_char(w, 'DD Mon') week, (select count(*)::int from job_files f where f.deleted_at is null and (${V.c_all})${wscope}
        and f.enquiry_ref is not null and f.created_at >= w and f.created_at < w + interval '7 days') count
      from generate_series(date_trunc('week', now() at time zone 'Asia/Dubai') - interval '7 weeks', date_trunc('week', now() at time zone 'Asia/Dubai'), interval '1 week') w order by w`, wp);
    pipeline = [['c_enquiry', 'New enquiries', c.new_enq], ['c_rates', 'Waiting for rates', c.rates], ['c_quoting', 'Quotation to make', c.quoting], ['c_approval', 'Pending approval', c.approval],
      ['c_sent', 'With the customer', c.sent], ['c_confirmed', 'To book', c.confirmed], ['c_booking', 'Booking pending', c.booking], ['c_prealert', 'Pre-alert pending', c.prealert],
      ['c_awaiting_job', 'Awaiting handover', c.awaiting_job]].map(([key, label, count]) => ({ key: key as string, label: label as string, count: count as number }));
  }

  if (role === 'agent_coordinator' || (actor.has('rates.agent_coordination') && !commercialSeer)) {
    const a = await one(`select count(*) filter (where status = 'requested')::int waiting, count(*) filter (where status = 'quoted' and received_at > now() - interval '7 days')::int received,
        count(*) filter (where status = 'requested' and needed_by < (now() at time zone 'Asia/Dubai')::date)::int late
      from vendor_requests where assigned_to = $1`, [actor.id]);
    sections.push({ key: 'agent', title: 'Rate requests assigned to me', cards: [
      { key: 'waiting', label: "Waiting for agents' rates", count: a.waiting, href: '/vendor-requests?mine=assigned&status=requested', icon: 'scale', tone: 'warn' },
      { key: 'late', label: 'Past the needed-by date', count: a.late, href: '/vendor-requests?mine=assigned&status=requested', icon: 'alert', tone: 'danger' },
      { key: 'received', label: 'Rates received (7 days)', count: a.received, href: '/vendor-requests?mine=assigned&status=', icon: 'scale', tone: 'ok' },
    ] });
  }

  const wh = actor.has('warehouse.view') || actor.has('warehouse.receive');
  const lcl = actor.has('lcl.view') || actor.has('lcl.receive') || actor.has('lcl.stuff') || actor.has('lcl.manage');
  if ((wh || lcl) && !['commercials_manager', 'coordinator', 'sales', 'agent_coordinator'].includes(role)) {
    const g = wh ? await one(`select count(*) filter (where status = 'expected')::int expected,
        count(*) filter (where status = 'expected' and coalesce(expected_date, current_date) <= (now() at time zone 'Asia/Dubai')::date)::int due from grns`) : { expected: 0, due: 0 };
    const l = lcl ? await one(`select
        (select count(*)::int from consolidation_shipments s join consolidations c on c.id = s.consolidation_id where s.removed_at is null and c.status in ('open','ready') and s.receiving_status in ('expected','partial')) expected,
        (select count(*)::int from consolidation_shipments s join consolidations c on c.id = s.consolidation_id where s.removed_at is null and c.status not in ('closed','cancelled') and s.receiving_status = 'discrepancy' and s.cargo_verified_at is null) diffs,
        (select count(*)::int from consolidations where status in ('ready','stuffing')) stuffing`) : { expected: 0, diffs: 0, stuffing: 0 };
    // Step 6: the LCL Team gets its own section — consolidations from waiting shipments to arrival
    if (role === 'lcl_team') {
      const x = await one(`select
          (select count(*)::int from job_files f where f.deleted_at is null and f.mode = 'sea_lcl' and f.status not in ('closed','cancelled')
             and (f.stage is null or f.stage not in ('enquiry','rates_requested','rates_received','quotation_draft','pending_approval','sent_to_customer','lost','cancelled'))
             and not exists (select 1 from consolidation_shipments s where s.job_file_id = f.id and s.removed_at is null)) waiting,
          (select count(*)::int from consolidations where status in ('open','ready')) open,
          (select count(*)::int from consolidations where status in ('dispatched','departed')) transit,
          (select count(*)::int from consolidations where status = 'arrived') arrived`);
      sections.push({ key: 'lcl', title: 'LCL', cards: [
        { key: 'waiting', label: 'Confirmed LCL shipments not in a container', count: x.waiting, href: '/lcl/new', icon: 'inbox', tone: 'warn' },
        { key: 'open', label: 'Open consolidations', count: x.open, href: '/lcl', icon: 'boxes' },
        { key: 'expected', label: 'Cargo expected at the warehouse', count: l.expected, href: '/lcl/shipments?view=pending_receiving', icon: 'warehouse' },
        { key: 'diffs', label: 'Cargo discrepancies', count: l.diffs, href: '/lcl/shipments?view=pending_receiving', icon: 'alert', tone: 'danger' },
        { key: 'stuffing', label: 'Awaiting stuffing', count: l.stuffing, href: '/lcl?view=stuffing', icon: 'boxes', tone: 'teal' },
        { key: 'transit', label: 'Containers in transit', count: x.transit, href: '/lcl?view=in_transit', icon: 'ship' },
        { key: 'arrived', label: 'Arrived, to deliver and close', count: x.arrived, href: '/lcl', icon: 'anchor', tone: 'ok' },
      ] });
    } else
    sections.push({ key: 'warehouse', title: 'Warehouse', cards: [
      { key: 'expected', label: 'Expected cargo', count: g.expected + l.expected, href: lcl ? '/lcl/shipments?view=pending_receiving' : '/warehouse/receipts', icon: 'boxes',
        hint: [wh && `${g.expected} goods receipts`, lcl && `${l.expected} LCL shipments`].filter(Boolean).join(', ') },
      ...(wh ? [{ key: 'inward', label: 'Pending inward (due)', count: g.due, href: '/warehouse/receipts', icon: 'warehouse', tone: 'warn' as const }] : []),
      ...(lcl ? [{ key: 'diffs', label: 'Cargo discrepancies', count: l.diffs, href: '/lcl/shipments?view=pending_receiving', icon: 'alert', tone: 'danger' as const },
        { key: 'stuffing', label: 'Consolidations awaiting stuffing', count: l.stuffing, href: '/lcl?view=stuffing', icon: 'boxes', tone: 'teal' as const }] : []),
    ] });
  }

  const ops = jf.canSeeJobFiles(actor) && ['operations_manager', 'freight_ops', 'operations', 'documentation_manager'].includes(role);
  if (ops) {
    const params: unknown[] = [];
    const scope = jf.jfScope(actor, params);
    const o = await one(`select count(*) filter (where f.stage = 'handed_over' and f.handed_over_at > now() - interval '30 days')::int received,
        count(*) filter (where ${jf.VIEWS.missing_docs.sql})::int docs, count(*) filter (where f.status in ('arrived','delivering'))::int delivery,
        count(*) filter (where ${jf.VIEWS.open.sql})::int active, count(*) filter (where ${jf.VIEWS.late.sql})::int late
      from job_files f where f.deleted_at is null${scope}`, params);
    sections.push({ key: 'operations', title: 'Operations', cards: [
      { key: 'received', label: 'Jobs received (30 days)', count: o.received, href: '/commercials/enquiries?view=c_handed_over', icon: 'arrowRight' },
      { key: 'docs', label: 'Pending documentation', count: o.docs, href: '/job-files?view=missing_docs', icon: 'folder', tone: 'warn' },
      { key: 'delivery', label: 'Pending delivery', count: o.delivery, href: '/job-files?status=arrived,delivering', icon: 'truck', tone: 'teal' },
      { key: 'active', label: 'Active shipments', count: o.active, href: '/job-files?view=open', icon: 'ship', tone: 'ok', hint: o.late ? `${o.late} past ETA` : undefined },
    ] });
  }

  const feed = await q(`select id, event, title, actor_name, job_file_id, quotation_id, vendor_request_id, job_id, run_id, pro_id, case_id, read_at, created_at
    from notifications where user_id = $1 order by created_at desc limit 8`, [actor.id]);
  return { sections, tasks, weekly, pipeline, feed };
}
