import { requireActor } from '@/server/auth';
import { createFromEmail } from '@/server/newenquiry';
import { route, body } from '@/server/http';
/** Save the checked enquiry (and the new customer, when there is one); the email is filed on it. */
export const POST = route(async (req, { params }) => createFromEmail(await requireActor(req), params.id, await body(req)));
