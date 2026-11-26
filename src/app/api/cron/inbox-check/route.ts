import { createHmac, timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import { runInboxChecks } from '@/server/inboxcron';
export const dynamic = 'force-dynamic';
/**
 * 24 Nov: called every 2 minutes by the Netlify scheduled function (netlify/functions/inbox-check.mjs).
 * Protected by a key made from SESSION_SECRET, so no new setting is needed and nobody else can trigger it.
 */
export async function POST(req: Request) {
  const want = createHmac('sha256', process.env.SESSION_SECRET || '').update('inbox-check').digest('hex');
  const got = req.headers.get('x-cron-key') ?? '';
  if (!process.env.SESSION_SECRET || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want)))
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  // 26 Nov: ?phase=read — the AI's background reading (vendor / booking replies, new-enquiry forms), its own call
  if (new URL(req.url).searchParams.get('phase') === 'read') {
    const { runBackgroundReads } = await import('@/server/inboxcron');
    return NextResponse.json(await runBackgroundReads());
  }
  const r = await runInboxChecks();
  return NextResponse.json({ ...r, done: r.done.map((d) => ({ ...d, user: d.user.slice(0, 8) })) });
}
