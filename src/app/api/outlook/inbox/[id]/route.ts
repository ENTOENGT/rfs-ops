import { requireActor } from '@/server/auth';
import { fileByHand, ignoreEmail } from '@/server/inbox';
import { route, body } from '@/server/http';
/** File a waiting email on a shipment ({ action: 'file', ref }) or hide it ({ action: 'ignore' }). */
export const POST = route(async (req, { params }) => {
  const actor = await requireActor(req);
  const b = await body(req);
  return b.action === 'ignore' ? ignoreEmail(actor, params.id) : fileByHand(actor, params.id, b);
});
