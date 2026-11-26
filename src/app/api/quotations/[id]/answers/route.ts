import { requireActor } from '@/server/auth';
import { markAnswerHandled } from '@/server/quoteanswers';
import { route, body } from '@/server/http';
/** 26 Nov: mark the customer's answer from the email as handled. */
export const POST = route(async (req, { params }) => markAnswerHandled(await requireActor(req), params.id, String((await body(req)).answer_id ?? '')));
