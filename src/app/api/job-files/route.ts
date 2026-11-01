import { requireActor } from '@/server/auth';
import { createJobFile, jobFileTiles, listJobFiles } from '@/server/jobfiles';
import { route, body, params } from '@/server/http';
export const dynamic = 'force-dynamic';
// GET: list (?tiles=1 for the dashboard tiles). POST: new Job File.
export const GET = route(async (req) => {
  const a = await requireActor(req);
  const p = params(req);
  return p.tiles === '1' ? jobFileTiles(a, p) : listJobFiles(a, p);
});
export const POST = route(async (req) => createJobFile(await requireActor(req), await body(req)));
