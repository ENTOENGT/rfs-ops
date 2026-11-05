import { requireActor } from '@/server/auth';
import { lclReport } from '@/server/lcl';
import { route, params as qp } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req, { params }) => lclReport(await requireActor(req), params.key, qp(req)));
