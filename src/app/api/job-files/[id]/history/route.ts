import { requireActor } from '@/server/auth';
import { historyFor, ignoreHint, useHint } from '@/server/history';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
/** Migration 038: suggestions for missing details from the customer's past jobs. POST { key, action: 'use' | 'ignore', value? }. */
export const GET = route(async (req, { params }) => historyFor(await requireActor(req), params.id));
export const POST = route(async (req, { params }) => {
  const actor = await requireActor(req);
  const b = await body(req);
  return b.action === 'ignore' ? ignoreHint(actor, params.id, b) : useHint(actor, params.id, b);
});
