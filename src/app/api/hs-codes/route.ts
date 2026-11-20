import { requireActor } from '@/server/auth';
import { checkHs, hsInfo, importTariff } from '@/server/hscodes';
import { route, params, body } from '@/server/http';
export const dynamic = 'force-dynamic';
/** GET ?codes=6404,64041100 checks HS codes (without codes: what list is loaded); POST { file, name } loads the Tariff Report. */
export const GET = route(async (req) => { await requireActor(req); const p = params(req); return p.codes ? checkHs(p.codes) : hsInfo(); });
export const POST = route(async (req) => importTariff(await requireActor(req), await body(req)));
