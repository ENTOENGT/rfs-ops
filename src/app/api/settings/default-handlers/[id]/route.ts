import { requireActor } from '@/server/auth';
import { removeDefaultHandler } from '@/server/handlers';
import { route } from '@/server/http';
export const DELETE = route(async (req, { params }) => removeDefaultHandler(await requireActor(req), params.id));
