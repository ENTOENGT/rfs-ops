import { requireActor } from '@/server/auth';
import { lclOptions } from '@/server/lcl';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => lclOptions(await requireActor(req)));
