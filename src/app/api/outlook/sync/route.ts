import { requireActor } from '@/server/auth';
import { syncInbox } from '@/server/inbox';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
/** Outlook step 3: read what is new in my inbox and file it on the right shipments. */
export const POST = route(async (req) => syncInbox(await requireActor(req)));
