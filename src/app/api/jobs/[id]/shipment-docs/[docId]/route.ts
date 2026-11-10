import { NextResponse } from 'next/server';
import { requireActor } from '@/server/auth';
import { transportShipmentDocUrl } from '@/server/handover';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';   // storage links must always be fresh
// Step 5: an operational document of the shipment, opened from the truck job (checked on every click; ?view=1 opens in the browser)
export const GET = route(async (req, { params }) => {
  const url = await transportShipmentDocUrl(await requireActor(req), params.id, params.docId, new URL(req.url).searchParams.get('view') === '1');
  return NextResponse.redirect(new URL(url, req.url), { status: 302, headers: { 'Cache-Control': 'no-store' } });
});
