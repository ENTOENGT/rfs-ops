import { requireActor } from '@/server/auth';
import { listDefaultHandlers, saveDefaultHandler } from '@/server/handlers';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => listDefaultHandlers(await requireActor(req)));
export const POST = route(async (req) => saveDefaultHandler(await requireActor(req), await body(req)));
