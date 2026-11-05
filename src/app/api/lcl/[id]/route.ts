import { requireActor } from '@/server/auth';
import { getConsolidation, updateConsolidation, consolidationAction, requestConUpload, confirmConUpload } from '@/server/lcl';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req, { params }) => getConsolidation(await requireActor(req), params.id));
export const PATCH = route(async (req, { params }) => updateConsolidation(await requireActor(req), params.id, await body(req)));
export const POST = route(async (req, { params }) => {
  const actor = await requireActor(req);
  const b = await body(req);
  if (b.action === 'upload-url') return requestConUpload(actor, params.id, b);
  if (b.action === 'upload-confirm') return confirmConUpload(actor, params.id, b);
  return consolidationAction(actor, params.id, b);
});
