import { requireActor } from '@/server/auth';
import { listTermTemplates, saveTermTemplate } from '@/server/templates';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => listTermTemplates(await requireActor(req)));
export const POST = route(async (req) => saveTermTemplate(await requireActor(req), await body(req)));
