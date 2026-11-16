import { requireActor } from '@/server/auth';
import { canPick, candidates, setHandler } from '@/server/handlers';
import { loadFile } from '@/server/jobfiles';
import { forbidden, notFound, one, pool } from '@/server/db';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
const KINDS = ['cs', 'ops', 'docs'] as const;
/** Who can be picked as this job's Customer Service / Operations / Documentation handler. */
export const GET = route(async (req, { params }) => {
  const a = await requireActor(req);
  if (!KINDS.includes((params.kind as any))) throw notFound('Part');
  const f: any = await loadFile(a, params.id);
  f.department_code = (await one('select code from departments where id = $1', [f.department_id]))?.code ?? null;
  if (!canPick(a, (params.kind as any), f)) throw forbidden();
  return candidates(pool(), (params.kind as any), f);
});
export const POST = route(async (req, { params }) => {
  if (!KINDS.includes((params.kind as any))) throw notFound('Part');
  return setHandler(await requireActor(req), params.id, (params.kind as any), await body(req));
});
