import { requireActor } from '@/server/auth';
import { globalSearch } from '@/server/search';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => globalSearch(await requireActor(req), Object.fromEntries(new URL(req.url).searchParams)));
