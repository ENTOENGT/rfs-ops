import { requireActor } from '@/server/auth';
import { suggestionsFor } from '@/server/agent';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
/** AI agent: the open suggestions on this enquiry, and received emails not read yet. */
export const GET = route(async (req, { params }) => suggestionsFor(await requireActor(req), params.id));
