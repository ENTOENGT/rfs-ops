import { requireActor } from '@/server/auth';
import { listEmails, saveEmailFile } from '@/server/emails';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
export const GET = route(async (req, { params }) => listEmails(await requireActor(req), params.id));
// save an uploaded .eml / .msg file as an email on the shipment
export const POST = route(async (req, { params }) => saveEmailFile(await requireActor(req), params.id, await body(req)));
