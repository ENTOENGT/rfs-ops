import { requireActor } from '@/server/auth';
import { listNotifications, markNotificationsRead } from '@/server/admin';
import { notificationsPage } from '@/server/notify';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
// the bell asks without parameters; the Notifications page asks for a page (with filters)
export const GET = route(async (req) => {
  const a = await requireActor(req);
  const p = Object.fromEntries(new URL(req.url).searchParams);
  return p.page ? notificationsPage(a, p) : listNotifications(a);
});
export const POST = route(async (req) => markNotificationsRead(await requireActor(req), (await body(req)).ids));
