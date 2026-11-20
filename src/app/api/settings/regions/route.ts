import { requireActor } from '@/server/auth';
import { listRegions, saveRegion } from '@/server/ports';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
/** Regions: your own groups of countries (used by agent coverage). */
export const GET = route(async (req) => listRegions(await requireActor(req)));
export const POST = route(async (req) => saveRegion(await requireActor(req), await body(req)));
