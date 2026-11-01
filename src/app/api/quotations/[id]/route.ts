import { requireActor } from '@/server/auth';
import { copyQuotation, customerCopy, customerExcel, getQuotation, quotationAction, updateQuotation } from '@/server/quotations';
import { route, body, params as qs } from '@/server/http';
export const dynamic = 'force-dynamic';
export const fetchCache = 'force-no-store';
// ?view=customer → the customer copy (selling only); ?format=xlsx → the same as an Excel file
export const GET = route(async (req, { params }) => {
  const a = await requireActor(req);
  const p = qs(req);
  if (p.format === 'xlsx') {
    const f = await customerExcel(a, params.id);
    return new Response(f.body, { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Cache-Control': 'no-store', 'Content-Disposition': `attachment; filename="${f.name}"` } });
  }
  return p.view === 'customer' ? customerCopy(a, params.id) : getQuotation(a, params.id);
});
export const PATCH = route(async (req, { params }) => updateQuotation(await requireActor(req), params.id, await body(req)));
// action: submit | approve | reject_approval | send | accept | decline | cancel | copy
export const POST = route(async (req, { params }) => {
  const a = await requireActor(req);
  const b = await body(req);
  return b.action === 'copy' ? copyQuotation(a, params.id) : quotationAction(a, params.id, b);
});
