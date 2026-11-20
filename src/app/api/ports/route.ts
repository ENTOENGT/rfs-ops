import { requireActor } from '@/server/auth';
import { addPort, searchPorts } from '@/server/ports';
import { route, params, body } from '@/server/http';
export const dynamic = 'force-dynamic';
/** Port / airport search (?q=&kind=sea|air&country=DE); POST adds your own port (Super Admin / Commercials Manager). */
export const GET = route(async (req) => searchPorts(await requireActor(req), params(req)));
export const POST = route(async (req) => addPort(await requireActor(req), await body(req)));
