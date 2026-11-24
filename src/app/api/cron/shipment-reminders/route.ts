import { createHmac, timingSafeEqual } from 'crypto';
import { NextResponse } from 'next/server';
import { runShipmentReminders } from '@/server/reminders';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;
/**
 * 24 Nov (migration 042): called every hour by the Netlify scheduled function (netlify/functions/shipment-reminders.mjs).
 * Protected by a key made from SESSION_SECRET, so no new setting is needed and nobody else can trigger it.
 */
export async function POST(req: Request) {
  const want = createHmac('sha256', process.env.SESSION_SECRET || '').update('shipment-reminders').digest('hex');
  const got = req.headers.get('x-cron-key') ?? '';
  if (!process.env.SESSION_SECRET || got.length !== want.length || !timingSafeEqual(Buffer.from(got), Buffer.from(want)))
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
  return NextResponse.json(await runShipmentReminders());
}
