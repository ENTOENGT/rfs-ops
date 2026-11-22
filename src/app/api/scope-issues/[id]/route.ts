import { requireActor } from '@/server/auth';
import { issueAction } from '@/server/recommend';
import { route, body } from '@/server/http';
/** Migration 039: { action: 'resolved', note } | { action: 'reopen' } on a mismatch the AI found. */
export const POST = route(async (req, { params }) => issueAction(await requireActor(req), params.id, await body(req)));
