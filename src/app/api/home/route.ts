import { requireActor } from '@/server/auth';
import { homeDashboard } from '@/server/home';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => homeDashboard(await requireActor(req)));
