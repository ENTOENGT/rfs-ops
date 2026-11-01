import { requireActor } from '@/server/auth';
import { listContacts, saveContact } from '@/server/contacts';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req, { params }) => listContacts(await requireActor(req), params.id));
// add / change ({ id }) / remove ({ id, remove: true })
export const POST = route(async (req, { params }) => saveContact(await requireActor(req), params.id, await body(req)));
