import { NextRequest, NextResponse } from 'next/server';
import { requireActor } from '@/server/auth';
import { finishConnect, STATE_COOKIE } from '@/server/outlook';
export const dynamic = 'force-dynamic';
/** Microsoft sends the person back here after they sign in (the address IT registered). */
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  let to: string;
  try {
    const a = await requireActor(req);
    const r = await finishConnect(a, { code: sp.get('code'), state: sp.get('state'), error: sp.get('error'), error_description: sp.get('error_description') },
      req.cookies.get(STATE_COOKIE)?.value);
    to = `/outlook?connected=${encodeURIComponent(r.email)}`;
  } catch (e: any) {
    if (e?.status === 401) return NextResponse.redirect(new URL('/login', req.url));
    to = `/outlook?error=${encodeURIComponent(e?.message ?? 'The connection failed')}`;
  }
  const res = NextResponse.redirect(new URL(to, req.url));
  res.cookies.set(STATE_COOKIE, '', { path: '/api/outlook', maxAge: 0 });
  return res;
}
