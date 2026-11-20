import { requireActor } from '@/server/auth';
import { bulkUpload } from '@/server/bulkimport';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
/** { file: base64 xlsx, import?: true } — without import it only checks and says row by row what would happen. */
export const POST = route(async (req) => { const b = await body(req); return bulkUpload(await requireActor(req), b, b.import === true); });
