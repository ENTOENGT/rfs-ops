/** 26 Nov (Point 16): the enquiry's steps, its one next action and what is open — worked out from the record. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { progressOf } from '../src/lib/commercialRules';

const now = (d: any) => progressOf(d).steps.findIndex((s) => s.state === 'now');
test('each stage gives the right step and next action', () => {
  const rate = (q: string | null) => ({ service: 'rate', status: q ? 'quoted' : 'requested', quoted_cost: q });
  assert.deepEqual([now({ stage: 'enquiry' }), progressOf({ stage: 'enquiry', can: { edit: true } }).next.tab], [1, 'rates']);
  const waiting = progressOf({ stage: 'rates_requested', vendor_requests: [rate('100'), rate(null)] });
  assert.equal(waiting.next.text, 'Waiting for vendor rates (1 of 2 received).');
  assert.deepEqual(waiting.pending, ['1 vendor rate awaited']);
  const all = progressOf({ stage: 'rates_requested', vendor_requests: [rate('100'), rate('90')] });
  assert.deepEqual([all.next.text, all.next.label, all.next.tab], ['Vendor rates received. Ready to compare.', 'Compare vendor rates', 'rates']);
  assert.equal(progressOf({ stage: 'quotation_draft', quotations: [{ id: 'q1', quote_no: 'Q-1', status: 'approved' }] }).next.label, 'Send quotation');
  const ok = progressOf({ stage: 'customer_confirmed', routes: [{ id: 'r2', option_no: 2, label: 'MSC via Singapore' }], selected_route_id: 'r2', approved_rate: { id: 'v' } });
  assert.deepEqual([ok.next.text, ok.next.label], ['Customer approved Option 2 – MSC via Singapore. Send the booking to the agent or carrier (or ask availability first).', 'Proceed to booking']);
  const conf = progressOf({ stage: 'customer_confirmed', availability: { status: 'confirmed' } });
  assert.deepEqual([conf.next.text, conf.next.label, now({ stage: 'customer_confirmed', availability: { status: 'confirmed' } })], ['Vendor confirmed availability.', 'Proceed to booking', 7]);
  assert.equal(progressOf({ stage: 'handed_over' }).steps.every((s) => s.state === 'done'), true);
  // 27 Nov: after booking, by sea: the BL draft first, chased the day after the cut-off
  const bk = (bl: string, cut?: string) => progressOf({ stage: 'prealert_awaited', mode: 'sea_fcl', bl_status: bl, cutoff_gate: cut }, '2026-12-05').next;
  assert.match(bk('awaiting', '2026-12-08').text, /Waiting for the BL draft .*cut-off \/ loading 2026-12-08/);
  assert.deepEqual([bk('awaiting', '2026-12-03').label, bk('awaiting', '2026-12-03').tab], ['Ask the agent', 'bl']);
  assert.match(bk('sent_to_customer').text, /with the customer/);
  assert.match(bk('customer_confirmed').text, /Waiting for the pre-alert/);
  assert.match(progressOf({ stage: 'prealert_awaited', mode: 'air' }).next.text, /pre-alert/);
  assert.deepEqual(progressOf({ stage: 'enquiry', enquiry_gaps: [1, 2], open_items: { clarifications: 1, answers: 0 } }).pending, ['2 missing details from the customer', '1 clarification open']);
});
