import { requireActor } from '@/server/auth';
import { addJobFileNote, getJobFile, saveJobFileContainer, saveMilestone, setJobFileStatus, updateJobFile } from '@/server/jobfiles';
import { bad } from '@/server/db';
import { confirmJfUpload, jfDocAction, requestJfUpload } from '@/server/jfdocs';
import { route, body } from '@/server/http';
import { confirmBooking, createOperationalJob, markLost, prealertAction, reassignPeople, requestBooking } from '@/server/commercial';
import { blAction, routeAction, vesselAction } from '@/server/routing';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const GET = route(async (req, { params }) => getJobFile(await requireActor(req), params.id));
export const PATCH = route(async (req, { params }) => updateJobFile(await requireActor(req), params.id, await body(req)));
// One door for every change; each action checks its own permission.
const ACTIONS: Record<string, (a: any, id: string, b: any) => Promise<unknown>> = {
  status: setJobFileStatus, container: saveJobFileContainer, milestone: saveMilestone, note: addJobFileNote,
  'upload-url': requestJfUpload, 'upload-confirm': confirmJfUpload, document: jfDocAction,
  // Part E: booking, pre-alert, operational job + handover, lost
  book: requestBooking, 'confirm-booking': confirmBooking, prealert: (a, id, b) => prealertAction(a, id, { ...b, action: b.step }),
  handover: createOperationalJob, lost: markLost, reassign: reassignPeople,
  // Part G2: route options, vessel legs, BL drafts
  route: routeAction, vessel: vesselAction, bl: blAction,
};
export const POST = route(async (req, { params }) => {
  const a = await requireActor(req);
  const b = await body(req);
  const fn = ACTIONS[String(b.action ?? '')];
  if (!fn) throw bad('Unknown action');
  return fn(a, params.id, b);
});
