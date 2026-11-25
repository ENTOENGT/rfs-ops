import { requireActor } from '@/server/auth';
import { calcLocal } from '@/server/localcharges';
import { route, body } from '@/server/http';
export const dynamic = 'force-dynamic';
/** 25 Nov (migration 044): work out the local charges for an enquiry / quotation (nothing is saved). */
export const POST = route(async (req) => calcLocal(await requireActor(req), await body(req)));
