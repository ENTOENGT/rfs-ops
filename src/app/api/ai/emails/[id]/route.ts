import { requireActor } from '@/server/auth';
import { readEmail } from '@/server/agent';
import { route } from '@/server/http';
/** AI agent: read one received email and suggest answers to the enquiry's missing details. */
export const POST = route(async (req, { params }) => readEmail(await requireActor(req), params.id));
