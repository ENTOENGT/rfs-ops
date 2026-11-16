import { requireActor } from '@/server/auth';
import { chatEdit } from '@/server/chat';
import { route, body } from '@/server/http';
export const PATCH = route(async (req, { params }) => chatEdit(await requireActor(req), params.id, params.msgId, await body(req)));
