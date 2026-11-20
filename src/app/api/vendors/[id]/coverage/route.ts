import { requireActor } from '@/server/auth';
import { listCoverage, saveCoverage } from '@/server/agents';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
/** Where this agent works (ports, countries, regions). */
export const GET = route(async (req, { params }) => listCoverage(await requireActor(req), params.id));
export const POST = route(async (req, { params }) => saveCoverage(await requireActor(req), params.id, await body(req)));
