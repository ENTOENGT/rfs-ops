import { requireActor } from '@/server/auth';
import { commercialOverview } from '@/server/commercial';
import { route, params } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => commercialOverview(await requireActor(req), params(req)));
