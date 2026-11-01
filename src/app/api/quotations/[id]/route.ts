import { requireActor } from '@/server/auth';
import { copyQuotation, getQuotation, quotationAction, updateQuotation } from '@/server/quotations';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const GET = route(async (req, { params }) => getQuotation(await requireActor(req), params.id));
export const PATCH = route(async (req, { params }) => updateQuotation(await requireActor(req), params.id, await body(req)));
// action: submit | approve | reject_approval | send | accept | decline | cancel | copy
export const POST = route(async (req, { params }) => {
  const a = await requireActor(req);
  const b = await body(req);
  return b.action === 'copy' ? copyQuotation(a, params.id) : quotationAction(a, params.id, b);
});
