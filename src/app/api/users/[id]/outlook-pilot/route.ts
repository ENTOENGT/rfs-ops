import { requireActor } from '@/server/auth';
import { setPilot } from '@/server/outlook';
import { route, body } from '@/server/http';
export const POST = route(async (req, { params }) => setPilot(await requireActor(req), params.id, !!(await body(req)).on));
