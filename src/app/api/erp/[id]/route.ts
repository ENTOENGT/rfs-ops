import { requireActor } from '@/server/auth';
import { batchAction, batchFile, getBatch } from '@/server/erp';
import { route, body, params as qs } from '@/server/http';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
// ?format=csv | xlsx → the export file
export const GET = route(async (req, { params }) => {
  const a = await requireActor(req);
  const f = qs(req).format;
  if (f === 'csv' || f === 'xlsx') {
    const x = await batchFile(a, params.id, f);
    return new Response(x.body, { headers: { 'Content-Type': x.type, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${x.name}"` } });
  }
  return getBatch(a, params.id);
});
export const POST = route(async (req, { params }) => batchAction(await requireActor(req), params.id, await body(req)));
