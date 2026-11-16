import { requireActor } from '@/server/auth';
import { listRoutes, saveRoute } from '@/server/handlers';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => listRoutes(await requireActor(req)));
export const POST = route(async (req) => saveRoute(await requireActor(req), await body(req)));
