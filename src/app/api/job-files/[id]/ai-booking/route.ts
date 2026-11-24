import { requireActor } from '@/server/auth';
import { bookingBox, readBooking } from '@/server/bookingreader';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
/** 24 Nov (migration 042): the line's / agent's booking emails as read by the AI (GET); read one now { email_id } (POST). */
export const GET = route(async (req, { params }) => bookingBox(await requireActor(req), params.id));
export const POST = route(async (req, { params }) => readBooking(await requireActor(req), params.id, String((await body(req)).email_id ?? '')));
