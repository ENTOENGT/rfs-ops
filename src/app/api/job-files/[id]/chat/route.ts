import { requireActor } from '@/server/auth';
import { chatList, chatPost, mentionable } from '@/server/chat';
import { route, body, params } from '@/server/http';
export const dynamic = 'force-dynamic';
// GET ?after=<time> for new messages only; ?mention=<text> for the @ picker
export const GET = route(async (req, { params: p }) => {
  const a = await requireActor(req);
  const qs = params(req);
  return qs.mention !== undefined ? mentionable(a, p.id, qs.mention) : chatList(a, p.id, qs);
});
export const POST = route(async (req, { params: p }) => chatPost(await requireActor(req), p.id, await body(req)));
