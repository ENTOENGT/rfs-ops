import { requireActor } from '@/server/auth';
import { chatInbox } from '@/server/chat';
import { route } from '@/server/http';
export const dynamic = 'force-dynamic';
export const GET = route(async (req) => chatInbox(await requireActor(req)));
