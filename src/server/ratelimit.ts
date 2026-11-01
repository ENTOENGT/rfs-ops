import { createHash } from 'crypto';
import { ApiError, q, one } from './db';

/**
 * Failed sign-ins per network address (migration 012).
 * The account lock in auth.ts stops guessing one account's password; this stops one address
 * trying many accounts, or many app links. Stored in the database because Netlify runs many
 * short-lived copies of the server, so a counter in memory would not be shared.
 */
export const RATE_LIMIT = { max: 20, minutes: 15 };
export type AttemptKind = 'login' | 'app_link';

/** The caller's address as Netlify reports it; never stored, only its hash. */
export function clientAddress(req: Request): string {
  const h = req.headers;
  return (h.get('x-nf-client-connection-ip') || h.get('x-forwarded-for')?.split(',')[0] || h.get('x-real-ip') || 'unknown').trim();
}
export const sourceKey = (address: string) => 'ip:' + createHash('sha256').update(address).digest('hex');

/** Refuse (429) when this address has failed too often in the last 15 minutes. */
export async function assertNotRateLimited(key: string, kind: AttemptKind) {
  const r = await one<{ n: string }>(
    `select count(*) n from login_attempts
      where source_key = $1 and kind = $2 and attempted_at > now() - ($3 || ' minutes')::interval`,
    [key, kind, String(RATE_LIMIT.minutes)]);
  if (Number(r?.n ?? 0) >= RATE_LIMIT.max)
    throw new ApiError(429, 'TOO_MANY_ATTEMPTS', `Too many failed attempts from this connection. Try again in ${RATE_LIMIT.minutes} minutes.`);
}

/** Record one failure. Old rows (over a day) are cleared now and then, so the table stays small. */
export async function recordFailedAttempt(key: string, kind: AttemptKind) {
  await q('insert into login_attempts (source_key, kind) values ($1, $2)', [key, kind]);
  if (Math.random() < 0.05) await q(`delete from login_attempts where attempted_at < now() - interval '1 day'`);
}

/**
 * Run a sign-in step with the address limit around it: refused up front when over the limit,
 * and a wrong password / bad link counts as one failure. Other errors (e.g. a disabled account) don't count.
 */
export async function withRateLimit<T>(req: Request, kind: AttemptKind, countsAsFailure: (e: any) => boolean, fn: () => Promise<T>): Promise<T> {
  const key = sourceKey(clientAddress(req));
  await assertNotRateLimited(key, kind);
  try {
    return await fn();
  } catch (e: any) {
    if (countsAsFailure(e)) await recordFailedAttempt(key, kind);
    throw e;
  }
}
