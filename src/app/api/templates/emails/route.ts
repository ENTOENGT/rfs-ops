import { requireActor } from '@/server/auth';
import { listEmailTemplates, saveEmailTemplate } from '@/server/templates';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => listEmailTemplates(await requireActor(req)));
export const POST = route(async (req) => saveEmailTemplate(await requireActor(req), await body(req)));
