import { requireActor } from '@/server/auth';
import { addJobFileNote, getJobFile, saveJobFileContainer, saveMilestone, setJobFileStatus, updateJobFile } from '@/server/jobfiles';
import { bad } from '@/server/db';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const GET = route(async (req, { params }) => getJobFile(await requireActor(req), params.id));
export const PATCH = route(async (req, { params }) => updateJobFile(await requireActor(req), params.id, await body(req)));
// One door for every change; each action checks its own permission.
const ACTIONS: Record<string, (a: any, id: string, b: any) => Promise<unknown>> = {
  status: setJobFileStatus, container: saveJobFileContainer, milestone: saveMilestone, note: addJobFileNote,
};
export const POST = route(async (req, { params }) => {
  const a = await requireActor(req);
  const b = await body(req);
  const fn = ACTIONS[String(b.action ?? '')];
  if (!fn) throw bad('Unknown action');
  return fn(a, params.id, b);
});
