import { requireActor } from '@/server/auth';
import { historyPreview } from '@/server/history';
import { route, body } from '@/server/http';
/** Migration 038: past-job suggestions for the New enquiry form (not saved yet). */
export const POST = route(async (req) => historyPreview(await requireActor(req), await body(req)));
