import { requireActor } from '@/server/auth';
import { createCase, listCases } from '@/server/cases';
import { route, body, params } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => listCases(await requireActor(req), params(req)));
export const POST = route(async (req) => createCase(await requireActor(req), await body(req)));
