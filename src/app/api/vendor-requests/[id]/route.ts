import { requireActor } from '@/server/auth';
import { getVendorRequest, vendorRequestAction } from '@/server/vendorreqs';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const GET = route(async (req, { params }) => getVendorRequest(await requireActor(req), params.id));
export const POST = route(async (req, { params }) => vendorRequestAction(await requireActor(req), params.id, await body(req)));
