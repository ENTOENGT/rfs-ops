import { requireActor } from '@/server/auth';
import { emailDraft, emailPrepared } from '@/server/emails';
import { route, body, params } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => emailDraft(await requireActor(req), params(req)));
export const POST = route(async (req) => emailPrepared(await requireActor(req), await body(req)));
