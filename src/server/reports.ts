/**
 * Phase 6 — Reports.
 * Every report (screen, print, CSV, Excel) is produced by the same server function, so the
 * confidentiality rules apply identically everywhere:
 *  - columns needing revenue / cost / profit are dropped server-side for users who can't see them
 *  - commercial tables are only joined when needed and allowed
 *  - sorting is only allowed on columns the user can see (no ranking by hidden revenue)
 * Exports are logged in the audit trail (who exported which report, with which filters).
 */
import ExcelJS from 'exceljs';
import { Actor } from './auth';
import { ApiError, audit, bad, forbidden, getSetting, pool, q } from './db';
import { financials } from './financials';
import { fromFils, toFils } from '../lib/finance';
import { jobScope } from './scope';

type ColType = 'text' | 'date' | 'datetime' | 'money' | 'int' | 'pct' | 'qty';
type Need = 'cost' | 'revenue' | 'profit';
interface Col { key: string; label: string; type: ColType; needs?: Need; width?: number; sort?: string }
interface ReportDef { key: string; title: string; description: string; costDescription?: string; kind: 'jobs' | 'group' | 'messenger' | 'pro' | 'rental' | 'jobfile' | 'warehouse' | 'cases' | 'vendors' | 'commercial'; category?: string; noPeriod?: boolean; proCharges?: boolean; cols: Col[]; group?: 'by_driver' | 'by_vehicle' | 'by_customer' | 'by_department'; podPending?: boolean; needsAny?: Need[] }

const JOB_BASE: Col[] = [
  { key: 'job_no', label: 'Job No.', type: 'text', width: 14, sort: 'upper(t.job_no)' },
  { key: 'job_number', label: 'Request No.', type: 'text', width: 13, sort: 't.job_number' },
  { key: 'required_date', label: 'Date', type: 'date', width: 12, sort: 't.required_date' },
];
export const REPORTS: Record<string, ReportDef> = {
  operational: {
    key: 'operational', title: 'Operational report', kind: 'jobs',
    description: 'Every job with route, vehicle, driver, status and POD.',
    cols: [...JOB_BASE,
      { key: 'department_name', label: 'Department', type: 'text', width: 16, sort: 'dep.name' },
      { key: 'slot', label: 'Time slot', type: 'text', width: 12 },
      { key: 'customer_name', label: 'Customer', type: 'text', width: 24, sort: 'c.name' },
      { key: 'boe_number', label: 'BOE', type: 'text', width: 14, sort: 't.boe_number' },
      { key: 'pickup_name', label: 'Pickup', type: 'text', width: 22 },
      { key: 'delivery_name', label: 'Delivery', type: 'text', width: 22 },
      { key: 'vehicle_type', label: 'Vehicle type', type: 'text', width: 12 },
      { key: 'vehicle_number', label: 'Vehicle', type: 'text', width: 13, sort: 've.vehicle_number' },
      { key: 'driver_name', label: 'Driver', type: 'text', width: 18, sort: 'dr.full_name' },
      { key: 'status_name', label: 'Status', type: 'text', width: 16, sort: 's.sort_order' },
      { key: 'pod_status_name', label: 'POD', type: 'text', width: 12 },
      { key: 'actual_delivery_at', label: 'Delivered at', type: 'datetime', width: 17, sort: 'a.actual_delivery_at' }],
  },
  // Part C (migration 016)
  cs_cases: { key: 'cs_cases', title: 'Customer service cases', kind: 'cases',
    description: 'Every case with first response and resolution time, and whether it missed its SLA. Period = date opened.',
    cols: [{ key: 'case_no', label: 'Case', type: 'text', width: 10 }, { key: 'created_at', label: 'Opened', type: 'datetime', width: 17 },
      { key: 'customer_name', label: 'Customer', type: 'text', width: 22 }, { key: 'job_no', label: 'Job No.', type: 'text', width: 14 },
      { key: 'kind', label: 'Type', type: 'text', width: 12 }, { key: 'priority', label: 'Priority', type: 'text', width: 9 },
      { key: 'subject', label: 'Subject', type: 'text', width: 30 }, { key: 'owner_name', label: 'Owner', type: 'text', width: 16 },
      { key: 'status', label: 'Status', type: 'text', width: 14 }, { key: 'response_hours', label: 'First response (h)', type: 'qty', width: 12 },
      { key: 'resolution_hours', label: 'Resolved in (h)', type: 'qty', width: 12 }, { key: 'sla_breached', label: 'SLA missed', type: 'text', width: 10 }] },
  vendor_performance: { key: 'vendor_performance', title: 'Vendor performance', kind: 'vendors',
    description: 'Per vendor: requests, completed, on time against the needed-by date, disputes, cancellations, average days. Period = date requested.',
    cols: [{ key: 'vendor_name', label: 'Vendor', type: 'text', width: 26 }, { key: 'vendor_type', label: 'Type', type: 'text', width: 14 },
      { key: 'requests', label: 'Requests', type: 'int', width: 9 }, { key: 'completed', label: 'Completed', type: 'int', width: 10 },
      { key: 'on_time', label: 'On time', type: 'int', width: 9 }, { key: 'late', label: 'Late', type: 'int', width: 7 },
      { key: 'on_time_pct', label: 'On time %', type: 'pct', width: 10 }, { key: 'disputes', label: 'Disputes', type: 'int', width: 9 },
      { key: 'cancelled', label: 'Cancelled', type: 'int', width: 10 }, { key: 'avg_days', label: 'Avg days', type: 'qty', width: 9 }] },
  // Warehouse (migration 015) — quantities only
  wh_stock: { key: 'wh_stock', title: 'Stock on hand', kind: 'warehouse', noPeriod: true,
    description: 'Stock now, by customer, warehouse, bin, SKU, batch and expiry: on hand, reserved and available.',
    cols: [{ key: 'customer_name', label: 'Customer', type: 'text', width: 22 }, { key: 'warehouse_code', label: 'Warehouse', type: 'text', width: 10 },
      { key: 'location_code', label: 'Bin', type: 'text', width: 12 }, { key: 'sku_code', label: 'SKU', type: 'text', width: 14 },
      { key: 'sku_name', label: 'Product', type: 'text', width: 28 }, { key: 'uom', label: 'Unit', type: 'text', width: 8 },
      { key: 'batch_no', label: 'Batch', type: 'text', width: 12 }, { key: 'expiry_date', label: 'Expiry', type: 'date', width: 12 },
      { key: 'condition', label: 'Condition', type: 'text', width: 11 }, { key: 'qty_on_hand', label: 'On hand', type: 'qty', width: 11 },
      { key: 'qty_reserved', label: 'Reserved', type: 'qty', width: 11 }, { key: 'qty_available', label: 'Available', type: 'qty', width: 11 }] },
  wh_expiry: { key: 'wh_expiry', title: 'Batch and expiry', kind: 'warehouse', noPeriod: true,
    description: 'Stock expiring in the next 90 days (or already expired), earliest first.',
    cols: [{ key: 'expiry_date', label: 'Expiry', type: 'date', width: 12 }, { key: 'days_left', label: 'Days left', type: 'int', width: 9 },
      { key: 'customer_name', label: 'Customer', type: 'text', width: 22 }, { key: 'sku_code', label: 'SKU', type: 'text', width: 14 },
      { key: 'sku_name', label: 'Product', type: 'text', width: 28 }, { key: 'batch_no', label: 'Batch', type: 'text', width: 12 },
      { key: 'warehouse_code', label: 'Warehouse', type: 'text', width: 10 }, { key: 'location_code', label: 'Bin', type: 'text', width: 12 },
      { key: 'qty_on_hand', label: 'On hand', type: 'qty', width: 11 }] },
  wh_ledger: { key: 'wh_ledger', title: 'Inventory ledger', kind: 'warehouse',
    description: 'Every stock movement: received, moved, adjusted, condition changed, dispatched — with who and why.',
    cols: [{ key: 'at', label: 'When', type: 'datetime', width: 17 }, { key: 'customer_name', label: 'Customer', type: 'text', width: 20 },
      { key: 'sku_code', label: 'SKU', type: 'text', width: 14 }, { key: 'sku_name', label: 'Product', type: 'text', width: 24 },
      { key: 'warehouse_code', label: 'Warehouse', type: 'text', width: 10 }, { key: 'location_code', label: 'Bin', type: 'text', width: 12 },
      { key: 'batch_no', label: 'Batch', type: 'text', width: 12 }, { key: 'condition', label: 'Condition', type: 'text', width: 10 },
      { key: 'kind', label: 'Movement', type: 'text', width: 18 }, { key: 'qty_change', label: 'Qty', type: 'qty', width: 10 },
      { key: 'balance_after', label: 'Balance after', type: 'qty', width: 12 }, { key: 'reference', label: 'Reference', type: 'text', width: 16 },
      { key: 'reason', label: 'Reason', type: 'text', width: 24 }, { key: 'user_name', label: 'By', type: 'text', width: 16 }] },
  wh_grn: { key: 'wh_grn', title: 'Goods received (GRN register)', kind: 'warehouse',
    description: 'Every received line with expected, received and damaged quantities and the difference. Period = date received.',
    cols: [{ key: 'grn_no', label: 'GRN', type: 'text', width: 11 }, { key: 'received_at', label: 'Received', type: 'datetime', width: 17 },
      { key: 'customer_name', label: 'Customer', type: 'text', width: 20 }, { key: 'job_no', label: 'Job No.', type: 'text', width: 14 },
      { key: 'reference', label: 'Reference', type: 'text', width: 16 }, { key: 'sku_code', label: 'SKU', type: 'text', width: 14 },
      { key: 'sku_name', label: 'Product', type: 'text', width: 24 }, { key: 'expected_qty', label: 'Expected', type: 'qty', width: 10 },
      { key: 'received_qty', label: 'Received good', type: 'qty', width: 12 }, { key: 'damaged_qty', label: 'Damaged', type: 'qty', width: 10 },
      { key: 'difference', label: 'Difference', type: 'qty', width: 11 }, { key: 'batch_no', label: 'Batch', type: 'text', width: 12 },
      { key: 'expiry_date', label: 'Expiry', type: 'date', width: 12 }] },
  wh_dispatch: { key: 'wh_dispatch', title: 'Dispatch register', kind: 'warehouse',
    description: 'Every dispatched order line. Period = date dispatched.',
    cols: [{ key: 'order_no', label: 'Order', type: 'text', width: 11 }, { key: 'dispatched_at', label: 'Dispatched', type: 'datetime', width: 17 },
      { key: 'customer_name', label: 'Customer', type: 'text', width: 20 }, { key: 'customer_reference', label: 'Customer ref.', type: 'text', width: 14 },
      { key: 'ship_to_name', label: 'Ship to', type: 'text', width: 22 }, { key: 'sku_code', label: 'SKU', type: 'text', width: 14 },
      { key: 'sku_name', label: 'Product', type: 'text', width: 24 }, { key: 'qty', label: 'Qty', type: 'qty', width: 10 },
      { key: 'packages', label: 'Packages', type: 'int', width: 9 }, { key: 'dispatch_reference', label: 'Vehicle / AWB', type: 'text', width: 18 }] },
  // Commercial reports (migration 024) — period = the date the enquiry was opened; money in the company currency
  salesman_performance: { key: 'salesman_performance', title: 'Salesman performance', kind: 'commercial', category: 'Commercial',
    description: 'Per Salesman: enquiries, quoted, confirmed and confirmed %, not confirmed with the reasons, volume (CBM, tonnes, TEU), days to quote, confirmed sales and profit or loss.',
    cols: [{ key: 'name', label: 'Salesman', type: 'text', width: 22, sort: 'x' }, { key: 'enquiries', label: 'Enquiries', type: 'int', width: 10, sort: 'x' },
      { key: 'quoted', label: 'Quoted', type: 'int', width: 9, sort: 'x' }, { key: 'waiting_approval', label: 'Waiting approval', type: 'int', width: 10 },
      { key: 'waiting_customer', label: 'Waiting customer', type: 'int', width: 10 }, { key: 'confirmed', label: 'Confirmed', type: 'int', width: 10, sort: 'x' },
      { key: 'confirmed_pct', label: 'Confirmed %', type: 'pct', width: 10, sort: 'x' },
      { key: 'handed_over', label: 'Handed over', type: 'int', width: 10 },
      { key: 'not_confirmed', label: 'Not confirmed', type: 'int', width: 10, sort: 'x' }, { key: 'lost_reasons', label: 'Why not confirmed', type: 'text', width: 34 },
      { key: 'open', label: 'Still open', type: 'int', width: 9 }, { key: 'conversion_pct', label: 'Quoted → confirmed %', type: 'pct', width: 12, sort: 'x' },
      { key: 'win_pct', label: 'Win rate %', type: 'pct', width: 10, sort: 'x' }, { key: 'days_to_quote', label: 'Avg days to quote', type: 'qty', width: 11, sort: 'x' },
      { key: 'won_cbm', label: 'Confirmed CBM', type: 'qty', width: 11, sort: 'x' }, { key: 'won_tonnes', label: 'Confirmed tonnes', type: 'qty', width: 11 },
      { key: 'won_teu', label: 'Confirmed TEU', type: 'int', width: 9 },
      { key: 'won_sales', label: 'Confirmed sales', type: 'money', needs: 'revenue', width: 14, sort: 'x' }, { key: 'won_profit', label: 'Profit / loss', type: 'money', needs: 'profit', width: 14, sort: 'x' },
      { key: 'margin_pct', label: 'Margin %', type: 'pct', needs: 'profit', width: 9 }] },
  coordinator_performance: { key: 'coordinator_performance', title: 'Coordinator performance', kind: 'commercial', category: 'Commercial',
    description: 'Per Coordinator: enquiries, agent rate requests and replies, days to quote, follow-ups, bookings, BL corrections, confirmed %, not confirmed with the reasons, volume and profit or loss.',
    cols: [{ key: 'name', label: 'Coordinator', type: 'text', width: 22, sort: 'x' }, { key: 'enquiries', label: 'Enquiries', type: 'int', width: 10, sort: 'x' },
      { key: 'rate_requests', label: 'Rate requests', type: 'int', width: 10, sort: 'x' }, { key: 'rates_received', label: 'Rates received', type: 'int', width: 10 },
      { key: 'agent_days', label: 'Avg agent reply (days)', type: 'qty', width: 12, sort: 'x' }, { key: 'quoted', label: 'Quoted', type: 'int', width: 9, sort: 'x' },
      { key: 'days_to_quote', label: 'Avg days to quote', type: 'qty', width: 11, sort: 'x' }, { key: 'waiting_customer', label: 'Customer follow-ups', type: 'int', width: 11 },
      { key: 'booking_open', label: 'Booking follow-ups', type: 'int', width: 11 }, { key: 'bl_corrections', label: 'BL corrections open', type: 'int', width: 11 },
      { key: 'confirmed', label: 'Confirmed', type: 'int', width: 10, sort: 'x' }, { key: 'confirmed_pct', label: 'Confirmed %', type: 'pct', width: 10, sort: 'x' },
      { key: 'handed_over', label: 'Handed over', type: 'int', width: 10, sort: 'x' },
      { key: 'not_confirmed', label: 'Not confirmed', type: 'int', width: 10, sort: 'x' }, { key: 'lost_reasons', label: 'Why not confirmed', type: 'text', width: 34 },
      { key: 'open', label: 'Still open', type: 'int', width: 9 },
      { key: 'win_pct', label: 'Win rate %', type: 'pct', width: 10, sort: 'x' },
      { key: 'won_cbm', label: 'Confirmed CBM', type: 'qty', width: 11, sort: 'x' }, { key: 'won_tonnes', label: 'Confirmed tonnes', type: 'qty', width: 11 },
      { key: 'won_teu', label: 'Confirmed TEU', type: 'int', width: 9 },
      { key: 'won_sales', label: 'Confirmed sales', type: 'money', needs: 'revenue', width: 14, sort: 'x' }, { key: 'won_profit', label: 'Profit / loss', type: 'money', needs: 'profit', width: 14, sort: 'x' }] },
  enquiry_tracking: { key: 'enquiry_tracking', title: 'Enquiry tracking', kind: 'commercial', category: 'Commercial',
    description: 'Every enquiry with Salesman, Coordinator, stage, days open, days to quote, quotation, result and Job No.',
    cols: [{ key: 'enquiry_ref', label: 'Enquiry Ref', type: 'text', width: 16, sort: 'x' }, { key: 'created_at', label: 'Opened', type: 'datetime', width: 17, sort: 'x' },
      { key: 'division_name', label: 'Division', type: 'text', width: 11 }, { key: 'type', label: 'Type', type: 'text', width: 12, sort: 'x' },
      { key: 'customer_name', label: 'Customer', type: 'text', width: 22, sort: 'x' }, { key: 'salesman_name', label: 'Salesman', type: 'text', width: 16, sort: 'x' },
      { key: 'coordinator_name', label: 'Coordinator', type: 'text', width: 16, sort: 'x' }, { key: 'route', label: 'Route', type: 'text', width: 24 },
      { key: 'stage_name', label: 'Stage', type: 'text', width: 18, sort: 'x' }, { key: 'days_open', label: 'Days open', type: 'int', width: 9, sort: 'x' },
      { key: 'rate_requests', label: 'Rate requests', type: 'int', width: 9 }, { key: 'days_to_quote', label: 'Days to quote', type: 'qty', width: 9, sort: 'x' },
      { key: 'volume_cbm', label: 'CBM', type: 'qty', width: 9 }, { key: 'weight_kg', label: 'Weight kg', type: 'qty', width: 10 },
      { key: 'containers', label: 'Containers', type: 'int', width: 9 },
      { key: 'quote_no', label: 'Quotation', type: 'text', width: 12 }, { key: 'quote_total', label: 'Quoted', type: 'money', needs: 'revenue', width: 13, sort: 'x' },
      { key: 'quote_profit', label: 'Profit / loss', type: 'money', needs: 'profit', width: 12, sort: 'x' }, { key: 'result', label: 'Result / reason', type: 'text', width: 26 },
      { key: 'job_no', label: 'Job No.', type: 'text', width: 13 }, { key: 'handed_over_at', label: 'Handed over', type: 'datetime', width: 17 }] },
  shipment_types: { key: 'shipment_types', title: 'Shipments by type', kind: 'commercial', category: 'Commercial',
    description: 'One line per shipment type (FCL / Air / LCL export and import, Cross Trade, Road Freight, Courier, Others) with a total — like the monthly sheet.',
    cols: [{ key: 'type', label: 'Type', type: 'text', width: 18 }, { key: 'enquiries', label: 'Enquiries', type: 'int', width: 10 },
      { key: 'quoted', label: 'Quoted', type: 'int', width: 9 }, { key: 'confirmed', label: 'Confirmed', type: 'int', width: 10 },
      { key: 'confirmed_pct', label: 'Confirmed %', type: 'pct', width: 10 }, { key: 'handed_over', label: 'Handed over', type: 'int', width: 10 },
      { key: 'not_confirmed', label: 'Not confirmed', type: 'int', width: 10 }, { key: 'lost_reasons', label: 'Why not confirmed', type: 'text', width: 34 },
      { key: 'open', label: 'Still open', type: 'int', width: 9 }, { key: 'win_pct', label: 'Win rate %', type: 'pct', width: 10 },
      { key: 'won_cbm', label: 'Confirmed CBM', type: 'qty', width: 11 }, { key: 'won_tonnes', label: 'Confirmed tonnes', type: 'qty', width: 11 },
      { key: 'won_teu', label: 'Confirmed TEU', type: 'int', width: 9 },
      { key: 'won_sales', label: 'Confirmed sales', type: 'money', needs: 'revenue', width: 14 }, { key: 'won_profit', label: 'Profit / loss', type: 'money', needs: 'profit', width: 14 }] },
  // Freight + 3PL (migration 013): one row per Job File, no prices
  jobfiles: { key: 'jobfiles', title: 'Job File register', kind: 'jobfile',
    description: 'Every Job File (shipment): direction, mode, route, BL/AWB, ETD/ETA, services and status. Period = date created.',
    cols: [
      { key: 'job_no', label: 'Job No.', type: 'text', width: 14, sort: 'x' },
      { key: 'created_at', label: 'Created', type: 'datetime', width: 17, sort: 'x' },
      { key: 'customer_name', label: 'Customer', type: 'text', width: 24, sort: 'x' },
      { key: 'direction_name', label: 'Direction', type: 'text', width: 11 },
      { key: 'mode_name', label: 'Mode', type: 'text', width: 10 },
      { key: 'route', label: 'Route', type: 'text', width: 26 },
      { key: 'carrier', label: 'Carrier', type: 'text', width: 16 },
      { key: 'mbl_mawb', label: 'MBL / MAWB', type: 'text', width: 16 },
      { key: 'hbl_hawb', label: 'HBL / HAWB', type: 'text', width: 16 },
      { key: 'container_list', label: 'Containers', type: 'text', width: 24 },
      { key: 'etd', label: 'ETD', type: 'date', width: 12, sort: 'x' },
      { key: 'eta', label: 'ETA', type: 'date', width: 12, sort: 'x' },
      { key: 'ata', label: 'Arrived', type: 'date', width: 12 },
      { key: 'services', label: 'Services', type: 'text', width: 22 },
      { key: 'trips', label: 'Trips', type: 'int', width: 7 },
      { key: 'pro_requests', label: 'PRO', type: 'int', width: 7 },
      { key: 'department_name', label: 'Department', type: 'text', width: 14 },
      { key: 'status_name', label: 'Status', type: 'text', width: 14 }],
  },
  financial: {
    key: 'financial', title: 'Financial report', kind: 'jobs', category: 'Finance', needsAny: ['cost', 'revenue'],
    description: 'Revenue, cost and profit per job. Transport users get a cost-only version.',
    costDescription: 'Transport cost per job.',
    cols: [...JOB_BASE,
      { key: 'department_name', label: 'Department', type: 'text', width: 16, sort: 'dep.name' },
      { key: 'customer_name', label: 'Customer', type: 'text', width: 24, sort: 'c.name' },
      { key: 'status_name', label: 'Status', type: 'text', width: 16, sort: 's.sort_order' },
      { key: 'net_revenue', label: 'Revenue (ex VAT)', type: 'money', needs: 'revenue', width: 15, sort: 'net' },
      { key: 'vat', label: 'VAT', type: 'money', needs: 'revenue', width: 11 },
      { key: 'total_cost', label: 'Cost', type: 'money', needs: 'cost', width: 13, sort: 'cost.total_cost' },
      { key: 'gross_profit', label: 'Profit', type: 'money', needs: 'profit', width: 13, sort: 'profit' },
      { key: 'margin_pct', label: 'Margin %', type: 'pct', needs: 'profit', width: 10 }],
  },
  department: groupReport('department', 'Department report', 'by_department', 'Department', 'Jobs, revenue, cost and profit per department.'),
  driver: groupReport('driver', 'Driver report', 'by_driver', 'Driver', 'Jobs, revenue, cost and profit per driver.'),
  vehicle: groupReport('vehicle', 'Vehicle report', 'by_vehicle', 'Vehicle', 'Jobs, revenue, cost and profit per vehicle.'),
  customer: groupReport('customer', 'Customer report', 'by_customer', 'Customer', 'Jobs, revenue, cost and profit per customer.'),
  messenger: {
    key: 'messenger', title: 'Messenger Report', kind: 'messenger',
    description: 'Every delivery: truck jobs (driver, vehicle) and messenger document runs, with delivery contact and documents.',
    cols: [
      { key: 'type', label: 'Type', type: 'text', width: 13, sort: 'type' },
      { key: 'request_date', label: 'Request date', type: 'date', width: 12, sort: 'request_date' },
      { key: 'job_no', label: 'Job No.', type: 'text', width: 14, sort: 'upper(job_no)' },
      { key: 'request_no', label: 'Request No.', type: 'text', width: 12, sort: 'request_no' },
      { key: 'requester_name', label: 'Requester', type: 'text', width: 18, sort: 'requester_name' },
      { key: 'department_name', label: 'Department', type: 'text', width: 16, sort: 'department_name' },
      { key: 'pickup', label: 'Pickup', type: 'text', width: 22, sort: 'pickup' },
      { key: 'delivery', label: 'Delivery', type: 'text', width: 22, sort: 'delivery' },
      { key: 'delivery_contact_person', label: 'Delivery contact', type: 'text', width: 18 },
      { key: 'delivery_contact_number', label: 'Contact number', type: 'text', width: 15 },
      { key: 'transporter', label: 'Assigned by (Transport)', type: 'text', width: 18, sort: 'transporter' },
      { key: 'vehicle_number', label: 'Vehicle', type: 'text', width: 12, sort: 'vehicle_number' },
      { key: 'driver_name', label: 'Driver', type: 'text', width: 16, sort: 'driver_name' },
      { key: 'messenger_name', label: 'Messenger', type: 'text', width: 16, sort: 'messenger_name' },
      { key: 'dispatch_at', label: 'Dispatched / collected', type: 'datetime', width: 17, sort: 'dispatch_at' },
      { key: 'delivered_at', label: 'Delivered', type: 'datetime', width: 17, sort: 'delivered_at' },
      { key: 'status_name', label: 'Status', type: 'text', width: 16, sort: 'status_sort' },
      { key: 'documents', label: 'Documents', type: 'text', width: 18 }],
  },
  pro_register: { key: 'pro_register', title: 'PRO Request Register', kind: 'pro',
    description: 'Every PRO clearance request: Job No., containers, BL, authorities, officer, status, deadline and completion.',
    cols: [
      { key: 'request_no', label: 'PRO Request No.', type: 'text', width: 14, sort: 'r.request_no' },
      { key: 'job_no', label: 'Job No.', type: 'text', width: 14, sort: 'upper(r.job_no)' },
      { key: 'customer_name', label: 'Customer', type: 'text', width: 22, sort: 'c.name' },
      { key: 'container_list', label: 'Containers', type: 'text', width: 26 },
      { key: 'bl_number', label: 'BL', type: 'text', width: 16, sort: 'r.bl_number' },
      { key: 'authorities', label: 'Authorities', type: 'text', width: 26 },
      { key: 'assigned_to_name', label: 'PRO officer', type: 'text', width: 16, sort: 'au.full_name' },
      { key: 'status_name', label: 'Status', type: 'text', width: 18, sort: 's.sort_order' },
      { key: 'deadline', label: 'Deadline', type: 'date', width: 12, sort: 'coalesce(r.deadline, r.required_date)' },
      { key: 'completed_at', label: 'Completed', type: 'datetime', width: 17, sort: 'r.completed_at' }] },
  pro_containers: { key: 'pro_containers', title: 'Container Clearance Report', kind: 'pro',
    description: 'Container by container: clearance stage, Customs clearance date, pending authority, release status and delays.',
    cols: [
      { key: 'container_no', label: 'Container', type: 'text', width: 14, sort: 'k.container_no' },
      { key: 'request_no', label: 'PRO Request No.', type: 'text', width: 14, sort: 'r.request_no' },
      { key: 'job_no', label: 'Job No.', type: 'text', width: 14, sort: 'upper(r.job_no)' },
      { key: 'customer_name', label: 'Customer', type: 'text', width: 20 },
      { key: 'stage', label: 'Clearance stage', type: 'text', width: 18 },
      { key: 'customs_cleared_at', label: 'Customs cleared', type: 'datetime', width: 17, sort: 'k.customs_cleared_at' },
      { key: 'pending_authority', label: 'Pending authority', type: 'text', width: 24 },
      { key: 'release_label', label: 'Port release', type: 'text', width: 14 },
      { key: 'released_at', label: 'Released', type: 'datetime', width: 17, sort: 'k.released_at' },
      { key: 'delay', label: 'Delayed', type: 'text', width: 9 },
      { key: 'delay_reason', label: 'Delay reason', type: 'text', width: 24 }] },
  pro_officers: { key: 'pro_officers', title: 'PRO Officer Performance', kind: 'pro',
    description: 'Per PRO officer: requests assigned, completed, open, overdue and average days to complete.',
    cols: [
      { key: 'officer', label: 'PRO officer', type: 'text', width: 22, sort: 'officer' },
      { key: 'assigned', label: 'Assigned', type: 'int', width: 10, sort: 'assigned' },
      { key: 'completed', label: 'Completed', type: 'int', width: 11, sort: 'completed' },
      { key: 'open', label: 'Open', type: 'int', width: 8, sort: 'open' },
      { key: 'overdue', label: 'Overdue', type: 'int', width: 9, sort: 'overdue' },
      { key: 'avg_days', label: 'Avg. days to complete', type: 'text', width: 14, sort: 'avg_days' }] },
  pro_authority_pending: { key: 'pro_authority_pending', title: 'Authority Pending Report', kind: 'pro',
    description: 'Authority activities not finished yet: reference no., submission date, what is pending, days pending, next action.',
    cols: [
      { key: 'authority', label: 'Authority', type: 'text', width: 24, sort: 'a.name' },
      { key: 'activity', label: 'Activity', type: 'text', width: 24, sort: 't.sort_order' },
      { key: 'reference_no', label: 'Reference / application no.', type: 'text', width: 18 },
      { key: 'request_no', label: 'PRO Request No.', type: 'text', width: 14, sort: 'r.request_no' },
      { key: 'job_no', label: 'Job No.', type: 'text', width: 14, sort: 'upper(r.job_no)' },
      { key: 'container_no', label: 'Container', type: 'text', width: 14 },
      { key: 'activity_status', label: 'Status', type: 'text', width: 16 },
      { key: 'submitted_on', label: 'Submitted', type: 'date', width: 12, sort: 'x.submitted_on' },
      { key: 'pending_requirement', label: 'Pending requirement', type: 'text', width: 28 },
      { key: 'days_pending', label: 'Days pending', type: 'int', width: 11, sort: 'days_pending' },
      { key: 'next_action', label: 'Next action', type: 'text', width: 26 },
      { key: 'next_action_by', label: 'By', type: 'text', width: 16 }] },
  pro_charges: { key: 'pro_charges', title: 'Clearance Charges Report', kind: 'pro', proCharges: true,
    description: 'Clearance charges by Job No., container, authority and category, with payment status. Estimates are shown apart from actual charges; nothing is posted to accounts.',
    cols: [
      { key: 'request_no', label: 'PRO Request No.', type: 'text', width: 14, sort: 'r.request_no' },
      { key: 'job_no', label: 'Job No.', type: 'text', width: 14, sort: 'upper(r.job_no)' },
      { key: 'container_no', label: 'Container', type: 'text', width: 14 },
      { key: 'authority', label: 'Authority', type: 'text', width: 22 },
      { key: 'category', label: 'Category', type: 'text', width: 18, sort: 'g.category' },
      { key: 'description', label: 'Description', type: 'text', width: 22 },
      { key: 'kind', label: 'Actual / estimate', type: 'text', width: 12 },
      { key: 'actual', label: 'Actual', type: 'money', width: 13, sort: 'g.amount' },
      { key: 'estimate', label: 'Estimate', type: 'money', width: 13 },
      { key: 'payment_status', label: 'Payment', type: 'text', width: 10, sort: 'g.payment_status' },
      { key: 'paid_on', label: 'Paid on', type: 'date', width: 12 },
      { key: 'receipt', label: 'Receipt', type: 'text', width: 20 }] },
  rentals: { key: 'rentals', title: 'Rental Truck Report', kind: 'rental', needsAny: ['cost'],
    description: 'Every approved rental truck: supplier, truck, driver, rental cost, supplier invoice and paid / unpaid.',
    cols: [
      { key: 'trip_date', label: 'Trip date', type: 'datetime', width: 17, sort: 'jr.planned_pickup_at' },
      { key: 'job_no', label: 'Job No.', type: 'text', width: 14, sort: 'upper(t.job_no)' },
      { key: 'job_number', label: 'Request No.', type: 'text', width: 12 },
      { key: 'supplier', label: 'Rental company', type: 'text', width: 22, sort: 's.name' },
      { key: 'vehicle_number', label: 'Truck', type: 'text', width: 12 },
      { key: 'vehicle_type', label: 'Type', type: 'text', width: 10 },
      { key: 'driver_name', label: 'Driver', type: 'text', width: 16 },
      { key: 'standard_cost', label: 'Standard rate', type: 'money', width: 13, needs: 'cost' },
      { key: 'rental_cost', label: 'Rental cost', type: 'money', width: 13, sort: 'jr.rental_cost', needs: 'cost' },
      { key: 'supplier_invoice_no', label: 'Supplier invoice', type: 'text', width: 16 },
      { key: 'payment_status', label: 'Payment', type: 'text', width: 10, sort: 'jr.payment_status' },
      { key: 'paid_on', label: 'Paid on', type: 'date', width: 12 },
      { key: 'job_status', label: 'Job status', type: 'text', width: 14 },
      { key: 'approved_by_name', label: 'Approved by', type: 'text', width: 16 }] },
  pod_pending: {
    key: 'pod_pending', title: 'POD pending report', kind: 'jobs', podPending: true,
    description: 'Delivered jobs still waiting for a POD (or whose POD was rejected).',
    cols: [...JOB_BASE,
      { key: 'customer_name', label: 'Customer', type: 'text', width: 24, sort: 'c.name' },
      { key: 'driver_name', label: 'Driver', type: 'text', width: 18, sort: 'dr.full_name' },
      { key: 'vehicle_number', label: 'Vehicle', type: 'text', width: 13 },
      { key: 'actual_delivery_at', label: 'Delivered at', type: 'datetime', width: 17, sort: 'a.actual_delivery_at' },
      { key: 'days_waiting', label: 'Days waiting', type: 'int', width: 12, sort: '(now() - a.actual_delivery_at)' },
      { key: 'pod_status_name', label: 'POD', type: 'text', width: 12 },
      { key: 'rejection_reason', label: 'Rejection reason', type: 'text', width: 28 }],
  },
};
function groupReport(key: string, title: string, group: 'by_driver' | 'by_vehicle' | 'by_customer' | 'by_department', label: string, description: string): ReportDef {
  return { key, title, description, kind: 'group', group, needsAny: ['cost', 'revenue'],
    costDescription: `Jobs and transport cost per ${label.toLowerCase()}.`, cols: [
    { key: 'label', label, type: 'text', width: 26 },
    { key: 'jobs', label: 'Jobs', type: 'int', width: 8 },
    { key: 'completed', label: 'Completed', type: 'int', width: 11 },
    { key: 'net_revenue', label: 'Revenue (ex VAT)', type: 'money', needs: 'revenue', width: 16 },
    { key: 'total_cost', label: 'Cost', type: 'money', needs: 'cost', width: 14 },
    { key: 'gross_profit', label: 'Profit', type: 'money', needs: 'profit', width: 14 },
    { key: 'margin_pct', label: 'Margin %', type: 'pct', needs: 'profit', width: 10 }] };
}

const proVisible = (a: Actor) => ['pro.view_all', 'pro.view_department', 'pro.create', 'pro.update', 'pro.assign'].some((x) => a.has(x as any));
const can = (a: Actor, n?: Need) => !n || (n === 'cost' ? a.fin.buyingView : n === 'revenue' ? a.fin.sellingView : a.fin.profitView);
const DATE = /^\d{4}-\d{2}-\d{2}$/, UUID = /^[0-9a-f-]{36}$/i;

/** With the money screens switched off, reports behave as if nobody can see revenue, VAT or profit. */
async function reportActor(actor: Actor): Promise<Actor> {
  const { moneyScreensOn } = await import('./financials');
  if (await moneyScreensOn()) return actor;
  return { ...actor, fin: { ...actor.fin, sellingView: false, sellingEdit: false, profitView: false } };
}

/** Commercial performance (Salesman / Coordinator, enquiries, types) is for the commercial side and managers who see
 *  quotations — not for Transport, PRO or Warehouse, even where they can open the Job File register. */
const commercialSide = (a: Actor) => a.isSuperAdmin || ['commercial.manage', 'jobfiles.view_assigned', 'quotes.view', 'quotes.create'].some((x) => a.has(x as any));
/** Groups for the report picker (UI redesign): one short list per area instead of one long row of buttons. */
const CATEGORY: Record<string, string> = { commercial: 'Commercial', jobfile: 'Shipments', vendors: 'Commercial', cases: 'Other',
  jobs: 'Transport', group: 'Transport', messenger: 'Transport', rental: 'Transport', pro: 'Customs (PRO)', warehouse: 'Warehouse' };
export async function reportList(realActor: Actor) {
  if (!realActor.has('reports.view')) throw forbidden();
  const actor = await reportActor(realActor);
  return Object.values(REPORTS)
    .filter((r) => !r.needsAny || r.needsAny.some((n) => can(actor, n)))
    .filter((r) => r.kind !== 'pro' || (proVisible(actor) && (!r.proCharges || actor.has('pro.charges.view'))))
    .filter((r) => r.kind !== 'cases' || actor.isSuperAdmin || actor.has('cases.view_all') || actor.has('cases.manage'))
    .filter((r) => r.kind !== 'vendors' || actor.isSuperAdmin || actor.has('vendors.requests') || actor.has('vendors.manage'))
    .filter((r) => r.kind !== 'warehouse' || ['warehouse.view', 'warehouse.receive', 'warehouse.dispatch', 'warehouse.configure', 'warehouse.orders.create'].some((x) => actor.has(x as any)))
    .filter((r) => r.kind !== 'commercial' || commercialSide(actor))
    .filter((r) => r.kind !== 'jobfile' || ['jobfiles.view_all', 'jobfiles.view_department', 'jobfiles.create', 'jobfiles.edit'].some((x) => actor.has(x as any)))
    .map((r) => ({ key: r.key, title: r.title, kind: r.kind, category: r.category ?? CATEGORY[r.kind] ?? 'Other', noPeriod: !!r.noPeriod || !!r.podPending,
      // Describe only what this person will actually see
      description: r.needsAny && !actor.fin.sellingView && r.costDescription ? r.costDescription : r.description }));
}

export interface ReportResult {
  report: { key: string; title: string; kind: string };
  columns: { key: string; label: string; type: ColType; sortable: boolean }[];
  rows: Record<string, unknown>[]; totals: Record<string, unknown> | null;
  total: number; page: number; page_size: number; filters: Record<string, string>;
}

export async function runReport(realActor: Actor, key: string, p: Record<string, string>, opts: { all?: boolean } = {}): Promise<ReportResult> {
  if (!realActor.has('reports.view')) throw forbidden();
  const actor = await reportActor(realActor);
  const def = REPORTS[key];
  if (!def) throw new ApiError(404, 'NOT_FOUND', 'Report not found');
  if (def.needsAny && !def.needsAny.some((n) => can(actor, n))) throw forbidden();
  const cols = def.cols.filter((c) => can(actor, c.needs));
  const colsOut = cols.map((c) => ({ key: c.key, label: c.label, type: c.type, sortable: !!c.sort }));

  if (!def.podPending && !def.noPeriod && (!DATE.test(p.from ?? '') || !DATE.test(p.to ?? ''))) throw bad('Choose a period');
  if (p.from && p.to && p.to < p.from) throw bad('The end date is before the start date');
  const FILTER_KEYS = ['from', 'to', 'q', 'department_id', 'customer_id', 'driver_id', 'vehicle_id', 'status',
    'type', 'job_no', 'request_no', 'requested_by', 'assigned_by', 'messenger_id', 'delivery',
    'container', 'authority_id', 'assigned_to', 'port', 'priority', 'payment_status', 'subcontractor_id', 'direction', 'mode', 'warehouse_id', 'days',
    'division', 'salesman_id', 'coordinator_id', 'stage'];
  const filters = Object.fromEntries(Object.entries(p).filter(([k, v]) => v && FILTER_KEYS.includes(k)));

  if (def.kind === 'messenger') return messengerReport(actor, def, cols, colsOut, p, opts);
  if (def.kind === 'rental') {
    const { rentalReport } = await import('./rentals');
    return rentalReport(actor, def, cols, colsOut, p, opts) as any;
  }
  if (def.kind === 'cases') {
    const { casesReport, canSeeCases } = await import('./cases');
    if (!canSeeCases(actor)) throw forbidden();
    return casesReport(actor, def, cols, colsOut, p, opts) as any;
  }
  if (def.kind === 'vendors') {
    const { vendorReport, canSeeVendorRequests } = await import('./vendorreqs');
    if (!canSeeVendorRequests(actor)) throw forbidden();
    return vendorReport(actor, def, cols, colsOut, p, opts) as any;
  }
  if (def.kind === 'warehouse') {
    const { warehouseReport, canSeeWarehouse } = await import('./warehouse');
    if (!canSeeWarehouse(actor)) throw forbidden();
    return warehouseReport(actor, def, cols, colsOut, p, opts) as any;
  }
  if (def.kind === 'commercial') {
    const { canSeeJobFiles } = await import('./jobfiles');
    if (!canSeeJobFiles(actor) || !commercialSide(actor)) throw forbidden();
    const { commercialReport } = await import('./commercialReports');
    return commercialReport(actor, def, cols, colsOut, p, opts) as any;
  }
  if (def.kind === 'jobfile') {
    const { jobFileReport, canSeeJobFiles } = await import('./jobfiles');
    if (!canSeeJobFiles(actor)) throw forbidden();
    return jobFileReport(actor, def, cols, colsOut, { ...p, from: p.from, to: p.to }, opts) as any;
  }
  if (def.kind === 'pro') {
    if (!proVisible(actor) || (def.proCharges && !actor.has('pro.charges.view'))) throw forbidden();
    const { proReport } = await import('./pro');
    return proReport(actor, def, cols, colsOut, p, opts) as any;
  }

  if (def.kind === 'group') {
    const f: any = await financials(actor, p);
    let rows: any[] = f[def.group!];
    if (p.q?.trim()) rows = rows.filter((r) => r.label.toLowerCase().includes(p.q.trim().toLowerCase()));
    if (p.sort && cols.some((c) => c.key === p.sort)) {
      const k = p.sort, dir = p.dir === 'asc' ? 1 : -1, c = cols.find((x) => x.key === k)!;
      rows = [...rows].sort((a, b) => dir * (c.type === 'text' ? String(a[k]).localeCompare(String(b[k])) : Number(a[k] ?? 0) - Number(b[k] ?? 0)));
    }
    const shaped = rows.map((r) => Object.fromEntries(cols.map((c) => [c.key, r[c.key] ?? null])));
    return { report: { key, title: def.title, kind: def.kind }, columns: colsOut, rows: shaped,
      totals: Object.fromEntries(cols.map((c) => [c.key, c.key === 'label' ? 'Total' : (f.totals[c.key] ?? null)])),
      total: shaped.length, page: 1, page_size: shaped.length, filters };
  }

  // ---- job-level reports
  const needCost = cols.some((c) => c.needs === 'cost' || c.needs === 'profit');
  const needRev = cols.some((c) => c.needs === 'revenue' || c.needs === 'profit');
  const params: unknown[] = [];
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  let where = `where t.deleted_at is null`;
  if (def.podPending) where += ` and s.stage = 'delivered' and t.pod_status in ('pending','rejected')`;
  else where += key === 'financial' ? ` and t.status_code not in ('draft','cancelled')` : '';
  if (p.from) where += ` and t.required_date >= ${add(p.from)}`;
  if (p.to) where += ` and t.required_date <= ${add(p.to)}`;
  where += jobScope(actor, params);
  for (const [k, col] of Object.entries({ department_id: 't.department_id', customer_id: 't.customer_id', driver_id: 'a.driver_id', vehicle_id: 'a.vehicle_id' }))
    if (p[k]) { if (!UUID.test(p[k])) throw bad('Invalid filter'); where += ` and ${col} = ${add(p[k])}`; }
  if (p.status) where += ` and t.status_code = any(${add(p.status.split(','))})`;
  if (p.q?.trim()) where += ` and t.search_text like ${add('%' + p.q.trim().toLowerCase().replace(/[%_\\]/g, '\\$&') + '%')}`;

  const sortCol = cols.find((c) => c.key === p.sort && c.sort);
  const order = sortCol ? `${sortCol.sort} ${p.dir === 'asc' ? 'asc' : 'desc'} nulls last, t.job_number desc`
    : def.podPending ? 'a.actual_delivery_at asc nulls last' : 't.required_date desc, t.job_number desc';
  const cap = opts.all ? 50000 : Math.min(Math.max(Number(p.page_size) || 100, 1), 500);
  const page = opts.all ? 1 : Math.max(Number(p.page) || 1, 1);

  const rows = await q(`select t.job_no, t.job_number, t.required_date, t.slot_from, t.slot_to, c.name customer_name, t.boe_number,
      t.pickup_name, t.delivery_name, vt.name vehicle_type, ve.vehicle_number, dr.full_name driver_name,
      s.name status_name, ps.name pod_status_name, dep.name department_name, a.actual_delivery_at, jp.rejection_reason,
      floor(extract(epoch from (now() - a.actual_delivery_at)) / 86400)::int days_waiting
      ${needCost ? ', cost.total_cost' : ''}
      ${needRev ? ', (rev.gross - coalesce(jc.discount,0)) net, round((rev.gross - coalesce(jc.discount,0)) * coalesce(jc.vat_rate,0) / 100, 2) vat' : ''}
      ${needCost && needRev ? ', (rev.gross - coalesce(jc.discount,0) - cost.total_cost) profit' : ''}
      , count(*) over() _total
    from transport_requests t
    join customers c on c.id = t.customer_id
    join job_statuses s on s.code = t.status_code
    join pod_statuses ps on ps.code = t.pod_status
    left join departments dep on dep.id = t.department_id
    left join transport_assignments a on a.job_id = t.id and a.is_current
    left join drivers dr on dr.id = a.driver_id
    left join vehicles ve on ve.id = a.vehicle_id
    left join vehicle_types vt on vt.id = coalesce(a.vehicle_type_id, t.requested_vehicle_type_id)
    left join job_pod jp on jp.job_id = t.id
    ${needCost ? 'left join lateral (select coalesce(sum(amount),0) total_cost from job_cost_lines where job_id = t.id) cost on true' : ''}
    ${needRev ? `left join job_commercials jc on jc.job_id = t.id
      left join lateral (select coalesce(sum(amount),0) gross from job_revenue_lines where job_id = t.id) rev on true` : ''}
    ${where} order by ${order} limit ${cap} offset ${(page - 1) * cap}`, params);

  const sums: Record<string, number> = {};
  const shaped = rows.map((r) => {
    const v: Record<string, unknown> = {
      ...r, slot: r.slot_from ? `${r.slot_from.slice(0, 5)}${r.slot_to ? '–' + r.slot_to.slice(0, 5) : ''}` : null,
      net_revenue: r.net ?? null, total_cost: r.total_cost ?? null, gross_profit: r.profit ?? null,
      margin_pct: r.net != null && r.profit != null && toFils(r.net) !== 0 ? (Math.round((toFils(r.profit) * 10000) / toFils(r.net)) / 100).toFixed(2) : null,
      days_waiting: r.actual_delivery_at ? r.days_waiting : null,
    };
    const out = Object.fromEntries(cols.map((c) => [c.key, v[c.key] ?? null]));
    for (const c of cols) if (c.type === 'money' && out[c.key] != null) sums[c.key] = (sums[c.key] ?? 0) + toFils(out[c.key] as string);
    return out;
  });
  let totals: Record<string, unknown> | null = null;
  if (cols.some((c) => c.type === 'money')) {
    // Totals over ALL matching rows, not just this page
    const all = !opts.all && Number(rows[0]?._total ?? 0) > rows.length ? await runReport(actor, key, p, { all: true }) : null;
    totals = all?.totals ?? Object.fromEntries(cols.map((c, i) => [c.key, i === 0 ? 'Total' : c.type === 'money' ? fromFils(sums[c.key] ?? 0)
      : c.key === 'margin_pct' && sums.net_revenue ? (Math.round(((sums.gross_profit ?? 0) * 10000) / sums.net_revenue) / 100).toFixed(2) : null]));
  }
  return { report: { key, title: def.title, kind: def.kind }, columns: colsOut, rows: shaped, totals,
    total: Number(rows[0]?._total ?? 0), page, page_size: cap, filters };
}

// ------------------------------------------------------------ export
export async function exportReport(actor: Actor, key: string, p: Record<string, string>, format: string) {
  if (!actor.has('reports.export')) throw forbidden('You do not have permission to export reports');
  if (!['csv', 'xlsx'].includes(format)) throw bad('Choose CSV or Excel');
  const r = await runReport(actor, key, p, { all: true });
  if (r.total > 50000) throw bad('Too many rows to export (over 50,000). Narrow the dates or filters.');
  const currency = await getSetting<string>('currency', 'AED');
  const company = await getSetting<string>('company_name', 'Company');
  const tz = await getSetting<string>('timezone', 'Asia/Dubai');
  const period = r.filters.from ? `${r.filters.from} to ${r.filters.to}` : 'All dates';
  const stamp = new Date().toLocaleString('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
  const fileBase = `${r.report.title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${r.filters.from ?? 'all'}${r.filters.to ? '-to-' + r.filters.to : ''}`;

  await audit(pool(), actor, { entity_type: 'report', entity_id: key, action: `Report exported (${format.toUpperCase()})`,
    new_value: `${r.report.title}, ${period}, ${r.total} rows${Object.keys(r.filters).length > 2 ? ', filtered' : ''}`, sensitivity: 'admin' });

  const cell = (c: ReportResult['columns'][number], v: unknown) => {
    if (v == null) return '';
    if (c.type === 'datetime') return new Date(String(v)).toLocaleString('en-GB', { timeZone: tz, dateStyle: 'short', timeStyle: 'short' });
    return v;
  };
  if (format === 'csv') {
    // Text that starts with = + - @ could run as a formula in Excel; neutralise it (numbers are left alone).
    const esc = (v: unknown, text = true) => {
      let s = String(v ?? '');
      if (text && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
      return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const isText = (c: ReportResult['columns'][number]) => !['money', 'pct', 'int', 'qty'].includes(c.type);
    const lines = [r.columns.map((c) => esc(c.label + (c.type === 'money' ? ` (${currency})` : ''))).join(','),
      ...r.rows.map((row) => r.columns.map((c) => esc(cell(c, row[c.key]), isText(c))).join(','))];
    if (r.totals) lines.push(r.columns.map((c) => esc(r.totals![c.key] ?? '', isText(c))).join(','));
    return { body: Buffer.from('\ufeff' + lines.join('\r\n'), 'utf8'), type: 'text/csv; charset=utf-8', name: `${fileBase}.csv` };
  }
  // Excel: title block, real numbers with formats, frozen header, auto filter
  const wb = new ExcelJS.Workbook();
  wb.creator = company; wb.created = new Date();
  const ws = wb.addWorksheet(r.report.title.slice(0, 31), { views: [{ state: 'frozen', ySplit: 5 }] });
  ws.addRow([company]).font = { bold: true, size: 14 };
  ws.addRow([r.report.title]).font = { bold: true, size: 12 };
  ws.addRow([`Period: ${period}`, '', '', `Generated: ${stamp} by ${actor.full_name}`]).font = { color: { argb: 'FF5E6B78' } };
  ws.addRow([]);
  const head = ws.addRow(r.columns.map((c) => c.label + (c.type === 'money' ? ` (${currency})` : '')));
  head.font = { bold: true }; head.eachCell((c) => { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE8E6E1' } }; c.border = { bottom: { style: 'thin' } }; });
  const defCols = REPORTS[key].cols;
  r.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = defCols.find((d) => d.key === c.key)?.width ?? 14;
    if (c.type === 'money') col.numFmt = '#,##0.00';
    if (c.type === 'pct') col.numFmt = '0.00"%"';
    if (c.type === 'qty') col.numFmt = '#,##0.###';
    if (c.type === 'date') col.numFmt = 'dd-mmm-yyyy';
  });
  const val = (c: ReportResult['columns'][number], v: unknown) => {
    if (v == null) return null;
    if (c.type === 'money' || c.type === 'pct' || c.type === 'int' || c.type === 'qty') return Number(v);
    if (c.type === 'date') return new Date(String(v) + 'T00:00:00Z');
    return cell(c, v);
  };
  for (const row of r.rows) ws.addRow(r.columns.map((c) => val(c, row[c.key])));
  if (r.totals) { const t = ws.addRow(r.columns.map((c) => val(c, r.totals![c.key]) ?? (c === r.columns[0] ? 'Total' : null))); t.font = { bold: true };
    t.eachCell((c) => { c.border = { top: { style: 'thin' } }; }); }
  ws.autoFilter = { from: { row: 5, column: 1 }, to: { row: 5, column: r.columns.length } };
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  return { body: buf, type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: `${fileBase}.xlsx` };
}

// ------------------------------------------------------------ Messenger Report
/**
 * One list of every delivery, from the data the app really records:
 *   Truck jobs     — transport_requests + current transport_assignments (driver, vehicle, who assigned it).
 *                    Dispatch time = when the job was moved to "Vehicle Dispatched" (from the job history).
 *   Messenger runs — messenger_runs (messenger, collected / delivered times). Job No. only if the run is
 *                    linked to a truck job; runs have no vehicle or driver.
 * Each half follows its own visibility rule (jobScope / runScope), so departments see only their own.
 * Request documents show how many are ready to print and how many expired under the 30-day rule —
 * the rows themselves never disappear when files are deleted.
 */
const OPEN_JOB = `('draft','requested','pending_assignment','assigned','confirmed','dispatched','picked_up','in_transit')`;
async function messengerReport(actor: Actor, def: ReportDef, cols: Col[], colsOut: ReportResult['columns'], p: Record<string, string>, opts: { all?: boolean }): Promise<ReportResult> {
  if (!DATE.test(p.from ?? '') || !DATE.test(p.to ?? '')) throw bad('Choose a period');
  if (p.to < p.from) throw bad('The end date is before the start date');
  const { runScope, canSeeRuns } = await import('./runs');
  const tz = await getSetting<string>('timezone', 'Asia/Dubai');
  const params: unknown[] = [];
  const add = (v: unknown) => { params.push(v); return `$${params.length}`; };
  const like = (v: string) => add('%' + v.trim().toLowerCase().replace(/[%_\\]/g, '\\$&') + '%');
  const uuid = (k: string) => { if (!UUID.test(p[k])) throw bad('Invalid filter'); return add(p[k]); };
  const fromP = add(p.from), toP = add(p.to);

  // ---- truck jobs (left out when filtering on a messenger or asking for runs only)
  const includeJobs = p.type !== 'runs' && !p.messenger_id;
  let jobs = '';
  if (includeJobs) {
  let jw = `where t.deleted_at is null and t.request_date between ${fromP} and ${toP}` + jobScope(actor, params);
  if (p.job_no?.trim()) jw += ` and lower(t.job_no) like ${like(p.job_no)}`;
  if (p.request_no?.trim()) jw += ` and lower(t.job_number) like ${like(p.request_no)}`;
  if (p.requested_by) jw += ` and t.requested_by = ${uuid('requested_by')}`;
  if (p.department_id) jw += ` and t.department_id = ${uuid('department_id')}`;
  if (p.assigned_by) jw += ` and a.assigned_by = ${uuid('assigned_by')}`;
  if (p.vehicle_id) jw += ` and a.vehicle_id = ${uuid('vehicle_id')}`;
  if (p.driver_id) jw += ` and a.driver_id = ${uuid('driver_id')}`;
  if (p.delivery?.trim()) jw += ` and lower(concat_ws(' ', t.delivery_name, t.delivery_address)) like ${like(p.delivery)}`;
  if (p.q?.trim()) jw += ` and t.search_text like ${like(p.q)}`;
  if (p.status === 'open') jw += ` and t.status_code in ${OPEN_JOB}`;
  if (p.status === 'delivered') jw += ` and s.stage in ('delivered','closed')`;
  if (p.status === 'cancelled') jw += ` and t.status_code = 'cancelled'`;
  if (p.status === 'failed') jw += ' and false';
  jobs = `select 'Truck job' as type, t.request_date, t.job_no, t.job_number request_no, ru.full_name requester_name, dep.name department_name,
      t.pickup_name pickup, t.delivery_name delivery, t.delivery_contact_person, t.delivery_contact_number,
      coalesce(sub.name, au.full_name) transporter, ve.vehicle_number, dr.full_name driver_name, null::text messenger_name,
      (select min(l.occurred_at) from audit_log l where l.job_id = t.id and l.field = 'Status' and l.new_value like 'Vehicle Dispatched%') dispatch_at,
      a.actual_delivery_at delivered_at, s.name status_name, s.sort_order status_sort,
      (select count(*) filter (where d.purged_at is null and (d.expires_at is null or d.expires_at > now()))::int from job_documents d
         join document_types dt on dt.code = d.document_type_code where d.job_id = t.id and d.deleted_at is null and dt.is_request_doc) docs_ready,
      (select count(*) filter (where d.purged_at is not null or d.expires_at <= now())::int from job_documents d
         join document_types dt on dt.code = d.document_type_code where d.job_id = t.id and d.deleted_at is null and dt.is_request_doc) docs_expired
    from transport_requests t
    join job_statuses s on s.code = t.status_code
    join users ru on ru.id = t.requested_by
    left join departments dep on dep.id = t.department_id
    left join transport_assignments a on a.job_id = t.id and a.is_current
    left join users au on au.id = a.assigned_by
    left join subcontractors sub on sub.id = a.subcontractor_id
    left join drivers dr on dr.id = a.driver_id
    left join vehicles ve on ve.id = a.vehicle_id
    ${jw}`;
  }

  // ---- messenger runs (only for people who may see runs at all)
  const RUN_STATUS = `case m.status when 'pending' then 'Waiting for a messenger' when 'assigned' then 'Assigned' when 'collected' then 'Collected'
      when 'delivered' then 'Delivered' when 'failed' then 'Could not complete' else 'Cancelled' end`;
  let runs = '';
  if (canSeeRuns(actor) && !p.vehicle_id && !p.driver_id && p.type !== 'jobs') {
    const tzP = add(tz);
    let rw = `where m.deleted_at is null and (m.created_at at time zone ${tzP})::date between ${fromP} and ${toP}` + runScope(actor, params);
    if (p.job_no?.trim()) rw += ` and lower(lj.job_no) like ${like(p.job_no)}`;
    if (p.request_no?.trim()) rw += ` and lower(m.run_number) like ${like(p.request_no)}`;
    if (p.requested_by) rw += ` and m.requested_by = ${uuid('requested_by')}`;
    if (p.department_id) rw += ` and m.department_id = ${uuid('department_id')}`;
    if (p.assigned_by) rw += ` and m.assigned_by = ${uuid('assigned_by')}`;
    if (p.messenger_id) rw += ` and m.messenger_id = ${uuid('messenger_id')}`;
    if (p.delivery?.trim()) rw += ` and lower(concat_ws(' ', m.to_name, m.to_address)) like ${like(p.delivery)}`;
    if (p.q?.trim()) rw += ` and m.search_text like ${like(p.q)}`;
    if (p.status === 'open') rw += ` and m.status in ('pending','assigned','collected')`;
    if (p.status === 'delivered') rw += ` and m.status = 'delivered'`;
    if (p.status === 'cancelled') rw += ` and m.status = 'cancelled'`;
    if (p.status === 'failed') rw += ` and m.status = 'failed'`;
    runs = `union all
    select 'Messenger run' as type, (m.created_at at time zone ${tzP})::date as request_date, lj.job_no, m.run_number as request_no,
      ru.full_name as requester_name, dep.name as department_name, m.from_name as pickup, m.to_name as delivery,
      m.to_contact_person as delivery_contact_person, m.to_contact_number as delivery_contact_number,
      au.full_name as transporter, null::text as vehicle_number, null::text as driver_name, mu.full_name as messenger_name,
      m.collected_at as dispatch_at, m.delivered_at, ${RUN_STATUS} as status_name,
      case m.status when 'pending' then 30 when 'assigned' then 40 when 'collected' then 70 when 'delivered' then 90 when 'failed' then 125 else 130 end as status_sort,
      null::int as docs_ready, null::int as docs_expired
    from messenger_runs m
    join users ru on ru.id = m.requested_by
    left join departments dep on dep.id = m.department_id
    left join users au on au.id = m.assigned_by
    left join users mu on mu.id = m.messenger_id
    left join transport_requests lj on lj.id = m.job_id
    ${rw}`;
  }
  const parts = [jobs, runs.replace(/^union all/, jobs ? 'union all' : '')].filter(Boolean).join('\n');
  if (!parts) return { report: { key: def.key, title: def.title, kind: def.kind }, columns: colsOut, rows: [], totals: null, total: 0, page: 1, page_size: 0, filters: p, summary: { truck_jobs: 0, messenger_runs: 0, delivered: 0, open: 0 } } as any;

  const sortCol = cols.find((c) => c.key === p.sort && c.sort);
  const order = sortCol ? `${sortCol.sort} ${p.dir === 'asc' ? 'asc' : 'desc'} nulls last, request_no desc` : 'request_date desc, request_no desc';
  const cap = opts.all ? 50000 : Math.min(Math.max(Number(p.page_size) || 100, 1), 500);
  const page = opts.all ? 1 : Math.max(Number(p.page) || 1, 1);
  const rows = await q(`with r as (${parts})
    select r.*, count(*) over() _total,
      count(*) filter (where type = 'Truck job') over() _jobs,
      count(*) filter (where delivered_at is not null) over() _delivered,
      count(*) filter (where status_sort < 90) over() _open
    from r order by ${order} limit ${cap} offset ${(page - 1) * cap}`, params);
  const shaped = rows.map((r) => {
    const docs = r.type !== 'Truck job' ? null
      : !r.docs_ready && !r.docs_expired ? 'None'
      : [r.docs_ready ? `${r.docs_ready} ready to print` : '', r.docs_expired ? `${r.docs_expired} expired` : ''].filter(Boolean).join(', ');
    return Object.fromEntries(cols.map((c) => [c.key, c.key === 'documents' ? docs : r[c.key] ?? null]));
  });
  const total = Number(rows[0]?._total ?? 0), jobsN = Number(rows[0]?._jobs ?? 0);
  return { report: { key: def.key, title: def.title, kind: def.kind }, columns: colsOut, rows: shaped, totals: null,
    total, page, page_size: cap, filters: Object.fromEntries(Object.entries(p).filter(([, v]) => v)),
    summary: { truck_jobs: jobsN, messenger_runs: total - jobsN, delivered: Number(rows[0]?._delivered ?? 0), open: Number(rows[0]?._open ?? 0) } } as any;
}
