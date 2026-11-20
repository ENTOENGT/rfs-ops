import { requireActor } from '@/server/auth';
import { draftEnquiry } from '@/server/newenquiry';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
/** "Create enquiry": the AI fills a new enquiry from this email (read once, then kept). */
export const POST = route(async (req, { params }) => draftEnquiry(await requireActor(req), params.id));
