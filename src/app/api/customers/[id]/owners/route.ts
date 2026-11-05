import { requireActor } from '@/server/auth';
import { customerOwners, setCustomerOwners } from '@/server/commercial';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req, { params }) => customerOwners(await requireActor(req), params.id));
export const PUT = route(async (req, { params }) => setCustomerOwners(await requireActor(req), params.id, await body(req)));
