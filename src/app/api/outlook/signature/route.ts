import { requireActor } from '@/server/auth';
import { mySignature, saveSignature } from '@/server/outlook';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
/** 26 Nov: my email signature picture — GET (preview), POST { data_url, width, height } or { remove: true }. */
export const GET = route(async (req) => mySignature(await requireActor(req)));
export const POST = route(async (req) => saveSignature(await requireActor(req), await body(req)));
