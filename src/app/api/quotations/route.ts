import { requireActor } from '@/server/auth';
import { createQuotation, listQuotations } from '@/server/quotations';
import { route, body, params } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => listQuotations(await requireActor(req), params(req)));
export const POST = route(async (req) => createQuotation(await requireActor(req), await body(req)));
