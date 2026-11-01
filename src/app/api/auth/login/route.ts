import { NextResponse } from 'next/server';
import { login, SESSION_COOKIE } from '@/server/auth';
import { route, body } from '@/server/http';
import { withRateLimit } from '@/server/ratelimit';
export const dynamic = 'force-dynamic';
export const POST = route(async (req) => {
  const b = await body(req);
  // A wrong email/mobile or password counts against this connection (migration 012).
  const s = await withRateLimit(req, 'login', (e) => e?.code === 'INVALID_LOGIN',
    () => login(String(b.email ?? ''), String(b.password ?? '')));
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, s.token, s.options);
  return res;
});
