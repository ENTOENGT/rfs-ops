import { requireActor } from '@/server/auth';
import { readQuote } from '@/server/quotereader';
import { route, body } from '@/server/http';
/** AI part B: { email_id } — the AI reads a vendor's reply and suggests the rate (nothing is saved on the request). */
export const POST = route(async (req) => readQuote(await requireActor(req), String((await body(req)).email_id ?? '')));
