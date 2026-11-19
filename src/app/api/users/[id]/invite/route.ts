import { requireActor } from '@/server/auth';
import { inviteUser } from '@/server/applink';
import { route } from '@/server/http';
/** Send (or prepare) the invitation email with a one-time sign-in link, valid 48 hours. */
export const POST = route(async (req, { params }) => inviteUser(await requireActor(req), params.id));
