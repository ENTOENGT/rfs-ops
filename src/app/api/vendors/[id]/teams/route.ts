import { requireActor } from '@/server/auth';
import { listTeams, saveTeam, teamsFor } from '@/server/vendorteams';
import { route, body, params } from '@/server/http';
export const dynamic = 'force-dynamic';
/** Migration 038: the vendor's teams (?file=<id> → the active ones and the one that fits that enquiry). */
export const GET = route(async (req, { params: p }) => {
  const actor = await requireActor(req);
  const qs = params(req);
  return qs.for !== undefined || qs.file !== undefined ? teamsFor(actor, p.id, qs.file) : listTeams(actor, p.id);
});
export const POST = route(async (req, { params: p }) => saveTeam(await requireActor(req), p.id, await body(req)));
