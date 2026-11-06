import { requireActor } from '@/server/auth';
import { pickTermsFor } from '@/server/templates';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => pickTermsFor(await requireActor(req), Object.fromEntries(new URL(req.url).searchParams)));
