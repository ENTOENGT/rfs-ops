import { requireActor } from '@/server/auth';
import { listQuoteChecks, saveQuoteCheck } from '@/server/checklists';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => listQuoteChecks(await requireActor(req)));
export const POST = route(async (req) => saveQuoteCheck(await requireActor(req), await body(req)));
