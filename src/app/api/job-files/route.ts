import { requireActor } from '@/server/auth';
import { jobFileTiles, listJobFiles } from '@/server/jobfiles';
import { createWithCustomer } from '@/server/newenquiry';
import { route, body, params } from '@/server/http';
export const dynamic = 'force-dynamic';
// GET: list (?tiles=1 for the dashboard tiles). POST: new Job File.
export const GET = route(async (req) => {
  const a = await requireActor(req);
  const p = params(req);
  return p.tiles === '1' ? jobFileTiles(a, p) : listJobFiles(a, p);
});
// a new customer (or walk-in) typed on New enquiry is added in the same save
export const POST = route(async (req) => createWithCustomer(await requireActor(req), await body(req)));
