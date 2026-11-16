import { requireActor } from '@/server/auth';
import { performance, performanceXlsx } from '@/server/performance';
import { route, params } from '@/server/http';
export const dynamic = 'force-dynamic';
// ?format=xlsx downloads the Excel workbook; otherwise the page data.
export const GET = route(async (req) => {
  const actor = await requireActor(req);
  const qs = params(req);
  if (qs.format === 'xlsx') {
    const f = await performanceXlsx(actor, qs);
    return new Response(f.body, { headers: { 'Content-Type': f.type, 'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${f.name}"` } });
  }
  return performance(actor, qs);
});
