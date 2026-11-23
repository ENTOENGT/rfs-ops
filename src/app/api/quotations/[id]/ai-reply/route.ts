import { requireActor } from '@/server/auth';
import { readReply, replyBox } from '@/server/quotereply';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
/** 23 Nov (migration 041): the customer's answers to this quotation as read by the AI (GET); read one now { email_id } (POST). */
export const GET = route(async (req, { params }) => replyBox(await requireActor(req), params.id));
export const POST = route(async (req, { params }) => readReply(await requireActor(req), params.id, String((await body(req)).email_id ?? '')));
