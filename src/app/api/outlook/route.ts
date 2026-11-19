import { requireActor } from '@/server/auth';
import { status, disconnect } from '@/server/outlook';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => status(await requireActor(req)));
export const DELETE = route(async (req) => disconnect(await requireActor(req)));
