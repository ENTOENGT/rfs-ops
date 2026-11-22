import { requireActor } from '@/server/auth';
import { recommendBox, runRecommend } from '@/server/recommend';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
/** Migration 039: the AI's best-vendor recommendation and mismatches (GET); compare again now (POST). Cost viewers only. */
export const GET = route(async (req, { params }) => recommendBox(await requireActor(req), params.id));
export const POST = route(async (req, { params }) => runRecommend(await requireActor(req), params.id));
