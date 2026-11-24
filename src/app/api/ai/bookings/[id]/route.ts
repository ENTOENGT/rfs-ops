import { requireActor } from '@/server/auth';
import { applyBooking, dismissBooking } from '@/server/bookingreader';
import { route, body } from '@/server/http';
/** 24 Nov: { action: 'save', fields: {…}, containers: [...] } or { action: 'dismiss' } on the AI's reading of a booking email. */
export const POST = route(async (req, { params }) => {
  const actor = await requireActor(req), b = await body(req);
  return b.action === 'dismiss' ? dismissBooking(actor, params.id) : applyBooking(actor, params.id, b);
});
