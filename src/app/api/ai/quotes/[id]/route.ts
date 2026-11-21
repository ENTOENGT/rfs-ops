import { requireActor } from '@/server/auth';
import { applyQuote, dismissQuote } from '@/server/quotereader';
import { route, body } from '@/server/http';
/** AI part B: { action: 'apply', rate: {...checked values}, use_charges } saves the rate on the request; { action: 'dismiss' }. */
export const POST = route(async (req, { params }) => {
  const actor = await requireActor(req);
  const b = await body(req);
  return b.action === 'dismiss' ? dismissQuote(actor, params.id) : applyQuote(actor, params.id, b);
});
