import { requireActor } from '@/server/auth';
import { userAssignments } from '@/server/team';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req, { params }) => userAssignments(await requireActor(req), params.id));
