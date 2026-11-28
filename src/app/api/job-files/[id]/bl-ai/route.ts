import { requireActor } from '@/server/auth';
import { blAiBox, blReplyAction, checkBlDraft } from '@/server/blai';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
/** 27 Nov: the AI on the BL draft — GET the box; POST { action: 'check' } or { action: 'record' | 'dismiss', id, notes? } on the customer's answer. */
export const GET = route(async (req, { params }) => blAiBox(await requireActor(req), params.id));
export const POST = route(async (req, { params }) => {
  const a = await requireActor(req); const b = await body(req);
  return b.action === 'check' ? checkBlDraft(a, params.id) : blReplyAction(a, params.id, b);
});
