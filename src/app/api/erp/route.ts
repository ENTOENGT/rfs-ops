import { requireActor } from '@/server/auth';
import { createBatch, erpOverview } from '@/server/erp';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => erpOverview(await requireActor(req)));
export const POST = route(async (req) => createBatch(await requireActor(req), await body(req)));
