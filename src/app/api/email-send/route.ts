import { requireActor } from '@/server/auth';
import { emailSend } from '@/server/emails';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
/** Outlook Step 2: send a prepared email from the signed-in person's own Outlook. */
export const POST = route(async (req) => emailSend(await requireActor(req), await body(req)));
