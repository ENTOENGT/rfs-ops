import { requireActor } from '@/server/auth';
import { suggestAgents } from '@/server/agents';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
/** The agents covering this enquiry's origin / destination (for "Ask agents for a rate"). */
export const GET = route(async (req, { params }) => suggestAgents(await requireActor(req), params.id));
