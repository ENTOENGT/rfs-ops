import { requireActor } from '@/server/auth';
import { sendAck } from '@/server/newenquiry';
import { route } from '@/server/http';
/** 26 Nov: Retry the automatic "Enquiry received" email (sent once only). */
export const POST = route(async (req, { params }) => sendAck(await requireActor(req), params.id));
