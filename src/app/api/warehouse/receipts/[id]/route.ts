import { requireActor } from '@/server/auth';
import { cancelGrn, getGrn, receiveGrn } from '@/server/warehouse';
import { bad } from '@/server/db';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const GET = route(async (req, { params }) => getGrn(await requireActor(req), params.id));
export const POST = route(async (req, { params }) => {
  const a = await requireActor(req);
  const b = await body(req);
  if (b.action === 'receive') return receiveGrn(a, params.id, b);
  if (b.action === 'cancel') return cancelGrn(a, params.id, b);
  throw bad('Unknown action');
});
