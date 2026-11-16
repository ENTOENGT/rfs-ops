import { requireActor } from '@/server/auth';
import { me, setPresence } from '@/server/presence';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => me(await requireActor(req)));
export const PUT = route(async (req) => setPresence(await requireActor(req), await body(req)));
