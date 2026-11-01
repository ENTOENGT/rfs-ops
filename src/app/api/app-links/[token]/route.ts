import { NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/server/auth';
import { appLinkInfo, useAppLink } from '@/server/applink';
import { route, body } from '@/server/http';
import { withRateLimit } from '@/server/ratelimit';
export const dynamic = 'force-dynamic';
// Opened from the link on the phone — no sign-in yet. The link itself is the proof,
// so guessing links is limited per connection (migration 012).
const badLink = (e: any) => e?.code === 'LINK_EXPIRED';
export const GET = route(async (req, { params }) => withRateLimit(req, 'app_link', badLink, () => appLinkInfo(params.token)));
export const POST = route(async (req, { params }) => {
  const b = await body(req);
  const s = await withRateLimit(req, 'app_link', badLink, () => useAppLink(params.token, b.password));
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, s.token, s.options);
  return res;
});
