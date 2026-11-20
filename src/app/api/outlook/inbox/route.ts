import { requireActor } from '@/server/auth';
import { listToFile } from '@/server/inbox';
import { route, params } from '@/server/http';
export const dynamic = 'force-dynamic';
/** My "Emails to file": inbox emails from customers / agents that matched no shipment. */
export const GET = route(async (req) => listToFile(await requireActor(req), params(req).all === '1'));
