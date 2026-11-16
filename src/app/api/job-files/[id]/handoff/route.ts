import { requireActor } from '@/server/auth';
import { doReceived, docsCleared } from '@/server/handlers';
import { bad } from '@/server/db';
import { route, body } from '@/server/http';
/** Ops → Documentation (DO received) and Documentation → Ops (cleared). */
export const POST = route(async (req, { params }) => {
  const a = await requireActor(req);
  const b = await body(req);
  if (b.what === 'do_received') return doReceived(a, params.id, b);
  if (b.what === 'cleared') return docsCleared(a, params.id, b);
  throw bad('Unknown step');
});
