import { requireActor } from '@/server/auth';
import { aiActivity } from '@/server/aiactivity';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
/** 26 Nov: the AI's live status for the top bar. */
export const GET = route(async (req) => aiActivity(await requireActor(req)));
