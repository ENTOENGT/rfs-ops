import { answerInfo, answerQuote } from '@/server/quoteanswers';
import { route, body } from '@/server/http';
import { clientAddress, withRateLimit } from '@/server/ratelimit';
export const dynamic = 'force-dynamic';
// 26 Nov: the customer's answer link from the quotation email — no sign-in; the link is the proof, wrong links limited per connection.
const badLink = (e: any) => e?.code === 'LINK_EXPIRED';
export const GET = route(async (req, { params }) => withRateLimit(req, 'quote_answer', badLink, () => answerInfo(params.token)));
export const POST = route(async (req, { params }) => {
  const b = await body(req);
  return withRateLimit(req, 'quote_answer', badLink, () => answerQuote(params.token, b, clientAddress(req)));
});
