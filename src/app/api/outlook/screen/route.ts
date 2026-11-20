import { requireActor } from '@/server/auth';
import { screenInbox } from '@/server/newenquiry';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
/** The AI takes a quick look at a few inbox emails that matched no shipment: new enquiry or not. */
export const POST = route(async (req) => screenInbox(await requireActor(req)));
