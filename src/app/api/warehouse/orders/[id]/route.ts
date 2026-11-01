import { requireActor } from '@/server/auth';
import { cancelOrder, dispatchOrder, getOrder, packOrder, pickOrder, reserveOrder } from '@/server/warehouse';
import { bad } from '@/server/db';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const GET = route(async (req, { params }) => getOrder(await requireActor(req), params.id));
const ACTIONS: Record<string, (a: any, id: string, b: any) => Promise<unknown>> = {
  reserve: reserveOrder, pick: (a, id) => pickOrder(a, id), pack: packOrder, dispatch: dispatchOrder, cancel: cancelOrder,
};
export const POST = route(async (req, { params }) => {
  const a = await requireActor(req);
  const b = await body(req);
  const fn = ACTIONS[String(b.action ?? '')];
  if (!fn) throw bad('Unknown action');
  return fn(a, params.id, b);
});
