import { requireActor } from '@/server/auth';
import { transportPrefill } from '@/server/handover';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
// Step 5: a transport request filled in from the shipment
export const GET = route(async (req, { params }) => transportPrefill(await requireActor(req), params.id));
