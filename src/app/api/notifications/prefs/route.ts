import { requireActor } from '@/server/auth';
import { saveNotificationPref } from '@/server/notify';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const POST = route(async (req) => saveNotificationPref(await requireActor(req), await body(req)));
