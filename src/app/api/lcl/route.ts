import { requireActor } from '@/server/auth';
import { listConsolidations, createConsolidation } from '@/server/lcl';
import { route, body, params } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => listConsolidations(await requireActor(req), params(req)));
export const POST = route(async (req) => createConsolidation(await requireActor(req), await body(req)));
