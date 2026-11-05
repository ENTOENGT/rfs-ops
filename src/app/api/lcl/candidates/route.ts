import { requireActor } from '@/server/auth';
import { lclCandidates } from '@/server/lcl';
import { route, params } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => lclCandidates(await requireActor(req), params(req)));
