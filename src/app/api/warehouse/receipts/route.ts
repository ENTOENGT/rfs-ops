import { requireActor } from '@/server/auth';
import { createGrn, listGrns } from '@/server/warehouse';
import { route, body, params } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => listGrns(await requireActor(req), params(req)));
export const POST = route(async (req) => createGrn(await requireActor(req), await body(req)));
