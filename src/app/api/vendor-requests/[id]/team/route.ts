import { requireActor } from '@/server/auth';
import { setRequestTeam } from '@/server/vendorteams';
import { route, body } from '@/server/http';
/** Migration 038: { team_id } — which of the vendor's teams this request goes to ('' = the vendor's own email). */
export const POST = route(async (req, { params }) => setRequestTeam(await requireActor(req), params.id, (await body(req)).team_id));
