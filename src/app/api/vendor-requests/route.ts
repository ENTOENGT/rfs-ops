import { requireActor } from '@/server/auth';
import { createVendorRequest, listVendorRequests } from '@/server/vendorreqs';
import { route, body, params } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => listVendorRequests(await requireActor(req), params(req)));
export const POST = route(async (req) => createVendorRequest(await requireActor(req), await body(req)));
