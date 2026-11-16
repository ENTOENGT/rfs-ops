import { requireActor } from '@/server/auth';
import { listDesignations, saveDesignation } from '@/server/admin';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => listDesignations(await requireActor(req)));
export const POST = route(async (req) => saveDesignation(await requireActor(req), await body(req)));
