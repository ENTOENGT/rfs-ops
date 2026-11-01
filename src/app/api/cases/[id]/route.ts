import { requireActor } from '@/server/auth';
import { caseAction, getCase } from '@/server/cases';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const GET = route(async (req, { params }) => getCase(await requireActor(req), params.id));
export const POST = route(async (req, { params }) => caseAction(await requireActor(req), params.id, await body(req)));
