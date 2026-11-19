import { requireActor } from '@/server/auth';
import { listEnquiryChecks, saveEnquiryCheck } from '@/server/checklists';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => listEnquiryChecks(await requireActor(req)));
export const POST = route(async (req) => saveEnquiryCheck(await requireActor(req), await body(req)));
