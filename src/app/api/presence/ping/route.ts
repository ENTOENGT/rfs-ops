import { requireActor } from '@/server/auth';
import { ping } from '@/server/presence';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const POST = route(async (req) => ping(await requireActor(req), await body(req)));
