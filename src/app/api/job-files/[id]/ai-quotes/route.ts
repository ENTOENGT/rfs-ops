import { requireActor } from '@/server/auth';
import { quoteBox } from '@/server/quotereader';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
/** AI part B: vendors' replies to rate requests on this enquiry — suggested rates, replies with no rate, replies not read yet. */
export const GET = route(async (req, { params }) => quoteBox(await requireActor(req), params.id));
