import { requireActor } from '@/server/auth';
import { removePerson } from '@/server/emailpeople';
import { route, body } from '@/server/http';
/** × on a person in the email box: off this shipment's customer emails for good ({ email }). */
export const POST = route(async (req, { params }) => removePerson(await requireActor(req), params.id, await body(req)));
