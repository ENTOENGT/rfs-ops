import { requireActor } from '@/server/auth';
import { createOrder, listOrders } from '@/server/warehouse';
import { route, body, params } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => listOrders(await requireActor(req), params(req)));
export const POST = route(async (req) => createOrder(await requireActor(req), await body(req)));
