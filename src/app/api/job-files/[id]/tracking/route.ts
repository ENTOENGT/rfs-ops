import { requireActor } from '@/server/auth';
import { markTracking, trackingFor } from '@/server/bookingreader';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
/** 24 Nov (migration 042): the Track buttons (GET); mark { what: 'sailed' | 'arrived', date } (POST). */
export const GET = route(async (req, { params }) => trackingFor(await requireActor(req), params.id));
export const POST = route(async (req, { params }) => markTracking(await requireActor(req), params.id, await body(req)));
