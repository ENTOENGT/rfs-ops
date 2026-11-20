import { requireActor } from '@/server/auth';
import { template } from '@/server/bulkimport';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
/** The Excel template for the bulk upload of customers and vendors. */
export const GET = route(async (req) => {
  const body = await template(await requireActor(req));
  return new Response(body, { headers: { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Cache-Control': 'no-store', 'Content-Disposition': 'attachment; filename="RFS-CRM-bulk-upload-template.xlsx"' } });
});
