import { requireActor } from '@/server/auth';
import { listCountries } from '@/server/ports';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => { await requireActor(req); return listCountries(); });
