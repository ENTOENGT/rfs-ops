import { requireActor } from '@/server/auth';
import { listCards, saveCard } from '@/server/localcharges';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
/** 25 Nov (migration 044): the local charges rate cards (GET); a new card (POST). */
export const GET = route(async (req) => listCards(await requireActor(req)));
export const POST = route(async (req) => saveCard(await requireActor(req), null, await body(req)));
