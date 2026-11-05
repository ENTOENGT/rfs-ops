import { requireActor } from '@/server/auth';
import { conDocumentUrl } from '@/server/lcl';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req, { params }) => conDocumentUrl(await requireActor(req), params.id, params.docId));
