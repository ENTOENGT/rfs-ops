import { requireActor } from '@/server/auth';
import { getCard, saveCard } from '@/server/localcharges';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
/** 25 Nov (migration 044): one rate card with its charges and history (GET); save it (PUT — the old version is kept). */
export const GET = route(async (req, { params }) => getCard(await requireActor(req), params.id));
export const PUT = route(async (req, { params }) => saveCard(await requireActor(req), params.id, await body(req)));
