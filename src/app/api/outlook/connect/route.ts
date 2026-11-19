import { NextRequest, NextResponse } from 'next/server';
import { requireActor } from '@/server/auth';
import { startConnect, STATE_COOKIE } from '@/server/outlook';
export const dynamic = 'force-dynamic';
/** "Connect my Outlook": off to Microsoft's sign-in page, with a one-time cookie that proves the sign-in was started here. */
export async function GET(req: NextRequest) {
  try {
    const a = await requireActor(req);
    const s = await startConnect(a);
    const res = NextResponse.redirect(s.url);
    res.cookies.set(STATE_COOKIE, s.cookie, { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/api/outlook', maxAge: 600 });
    return res;
  } catch (e: any) {
    if (e?.status === 401) return NextResponse.redirect(new URL('/login', req.url));
    return NextResponse.redirect(new URL(`/outlook?error=${encodeURIComponent(e?.message ?? 'Could not start the sign-in')}`, req.url));
  }
}
