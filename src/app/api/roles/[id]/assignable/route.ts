import { requireActor } from '@/server/auth';
import { setAssignableRoles } from '@/server/admin';
import { route, body } from '@/server/http';
export const PUT = route(async (req, { params }) => setAssignableRoles(await requireActor(req), params.id, (await body(req)).roles));
