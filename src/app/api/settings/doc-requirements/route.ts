import { requireActor } from '@/server/auth';
import { docRequirements, saveDocRequirement } from '@/server/jfdocs';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => docRequirements(await requireActor(req)));
export const POST = route(async (req) => saveDocRequirement(await requireActor(req), await body(req)));
