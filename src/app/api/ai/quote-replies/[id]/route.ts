import { requireActor } from '@/server/auth';
import { applyReply } from '@/server/quotereply';
import { route, body } from '@/server/http';
/** 23 Nov: { action: 'accepted' | 'changes' | 'declined' | 'question' | 'dismiss', … } on the AI's reading of a customer's answer. */
export const POST = route(async (req, { params }) => applyReply(await requireActor(req), params.id, await body(req)));
