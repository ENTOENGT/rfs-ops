import { requireActor } from '@/server/auth';
import { listHouseShipments } from '@/server/lcl';
import { route, params } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => listHouseShipments(await requireActor(req), params(req)));
