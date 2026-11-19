/**
 * G3 step 1 (migration 029) — connecting a pilot user's own Outlook mailbox through Microsoft sign-in.
 *
 *  - Settings (Netlify environment, never in the code): MS_TENANT_ID, MS_CLIENT_ID, MS_CLIENT_SECRET, APP_URL.
 *  - Delegated permissions only: RFS CRM reaches only the mailbox of the person who signed in.
 *  - Sign-in uses a one-time "state" and PKCE, kept in a short httpOnly cookie, so a stolen link cannot connect a mailbox.
 *  - The Microsoft tokens are encrypted (AES-256-GCM) before they are saved, and never sent to the browser.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { SignJWT, jwtVerify } from 'jose';
import { Actor } from './auth';
import { ApiError, audit, forbidden, notFound, one, pool, q } from './db';

export const SCOPES = 'openid profile email offline_access User.Read Mail.ReadWrite Mail.Send';
export const STATE_COOKIE = 'ol_state';
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Tests replace the network with a fake Microsoft. */
let net: typeof fetch = (...a) => fetch(...a);
export const setNetwork = (f: typeof fetch) => { net = f; };

export function config() {
  const tenant = process.env.MS_TENANT_ID, client = process.env.MS_CLIENT_ID, secret = process.env.MS_CLIENT_SECRET;
  const app = (process.env.APP_URL || 'https://rfsops.netlify.app').replace(/\/$/, '');
  return { ready: !!(tenant && client && secret), tenant, client, secret, redirect: `${app}/api/outlook/callback`, app };
}
function mustConfig() {
  const c = config();
  if (!c.ready) throw new ApiError(503, 'NOT_SET_UP', 'The Outlook connection is not set up yet (Microsoft details missing in the hosting settings)');
  return { tenant: c.tenant as string, client: c.client as string, secret: c.secret as string, redirect: c.redirect, app: c.app };
}

// ---------------------------------------------------------------- encryption of the saved tokens
function key() {
  const s = process.env.OUTLOOK_TOKEN_KEY || process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error('SESSION_SECRET must be set (32+ characters)');
  return createHash('sha256').update(`rfs-ops/outlook/${s}`).digest();
}
export function seal(text: string) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64url')).join('.');
}
export function unseal(box: string) {
  const [iv, tag, enc] = box.split('.').map((x) => Buffer.from(x, 'base64url'));
  const d = createDecipheriv('aes-256-gcm', key(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString('utf8');
}
const stateKey = () => createHash('sha256').update(`rfs-ops/outlook-state/${process.env.SESSION_SECRET}`).digest();

// ---------------------------------------------------------------- who may connect
async function isPilot(userId: string) {
  return !!(await one('select outlook_pilot from users where id = $1 and is_active and deleted_at is null', [userId]))?.outlook_pilot;
}

/** The Super Admin switches the pilot on or off for one person. Switching off also disconnects their mailbox. */
export async function setPilot(actor: Actor, userId: string, on: boolean) {
  if (!actor.isSuperAdmin && !actor.has('users.manage')) throw forbidden('Only the Super Admin chooses the Outlook pilot users');
  if (!isUuid(userId)) throw notFound('User');
  const u = await one('select full_name, outlook_pilot from users where id = $1 and deleted_at is null', [userId]);
  if (!u) throw notFound('User');
  if (u.outlook_pilot === on) return { ok: true };
  await q('update users set outlook_pilot = $2 where id = $1', [userId, on]);
  if (!on) await q('delete from outlook_connections where user_id = $1', [userId]);
  await audit(pool(), actor, { entity_type: 'user', entity_id: userId, action: on ? 'Outlook pilot switched on' : 'Outlook pilot switched off', new_value: u.full_name, sensitivity: 'admin' });
  return { ok: true };
}

export async function status(actor: Actor) {
  const c = await one('select ms_email, ms_name, connected_at, last_sync_at, last_error from outlook_connections where user_id = $1', [actor.id]);
  return { configured: config().ready, pilot: await isPilot(actor.id), connected: !!c, ...(c ?? {}) };
}

// ---------------------------------------------------------------- sign-in with Microsoft
/** Step 1 of the sign-in: the Microsoft page to send the person to, and the one-time cookie that proves it was them. */
export async function startConnect(actor: Actor) {
  const c = mustConfig();
  if (!(await isPilot(actor.id))) throw forbidden('Outlook is only for the pilot users for now. Ask the Super Admin.');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const nonce = randomBytes(16).toString('base64url');
  const cookie = await new SignJWT({ n: nonce, v: verifier }).setProtectedHeader({ alg: 'HS256' }).setSubject(actor.id)
    .setIssuedAt().setExpirationTime('10m').sign(stateKey());
  const url = new URL(`https://login.microsoftonline.com/${c.tenant}/oauth2/v2.0/authorize`);
  for (const [k, v] of Object.entries({ client_id: c.client, response_type: 'code', redirect_uri: c.redirect, response_mode: 'query', scope: SCOPES,
    state: nonce, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'select_account', login_hint: actor.email ?? '' })) url.searchParams.set(k, v);
  return { url: url.toString(), cookie };
}

async function tokenCall(params: Record<string, string>) {
  const c = mustConfig();
  const res = await net(`https://login.microsoftonline.com/${c.tenant}/oauth2/v2.0/token`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: c.client, client_secret: c.secret, redirect_uri: c.redirect, scope: SCOPES, ...params }).toString(),
  });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.access_token) throw new ApiError(502, 'MS_SIGN_IN', `Microsoft refused the sign-in${j.error_description ? `: ${String(j.error_description).split('\n')[0].slice(0, 200)}` : ''}`);
  return j as { access_token: string; refresh_token?: string; expires_in: number; scope?: string };
}

/** Step 2 of the sign-in: Microsoft sends the person back with a code; it is checked against the cookie and swapped for tokens. */
export async function finishConnect(actor: Actor, p: { code?: string | null; state?: string | null; error?: string | null; error_description?: string | null }, cookie: string | undefined) {
  if (p.error) throw new ApiError(400, 'MS_SIGN_IN', p.error === 'access_denied' ? 'The Microsoft sign-in was cancelled' : `Microsoft: ${String(p.error_description ?? p.error).split('\n')[0].slice(0, 200)}`);
  if (!cookie || !p.code || !p.state) throw new ApiError(400, 'MS_SIGN_IN', 'The sign-in link has expired. Please press Connect again.');
  let s: any;
  try { s = (await jwtVerify(cookie, stateKey())).payload; } catch { throw new ApiError(400, 'MS_SIGN_IN', 'The sign-in link has expired. Please press Connect again.'); }
  if (s.sub !== actor.id || s.n !== p.state) throw new ApiError(400, 'MS_SIGN_IN', 'This sign-in was started by someone else. Please press Connect again.');
  if (!(await isPilot(actor.id))) throw forbidden('Outlook is only for the pilot users for now');
  const t = await tokenCall({ grant_type: 'authorization_code', code: p.code, code_verifier: s.v });
  if (!t.refresh_token) throw new ApiError(502, 'MS_SIGN_IN', 'Microsoft did not allow staying connected (offline access). Ask IT to check the permissions.');
  const me = await net('https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName', { headers: { Authorization: `Bearer ${t.access_token}` } });
  const m: any = await me.json().catch(() => ({}));
  if (!me.ok || !m.id) throw new ApiError(502, 'MS_GRAPH', 'Could not read the Microsoft account');
  const email = String(m.mail || m.userPrincipalName || '').toLowerCase();
  await q(`insert into outlook_connections (user_id, ms_user_id, ms_email, ms_name, refresh_token_enc, access_token_enc, access_expires_at, scope, connected_at, last_error, updated_at)
      values ($1,$2,$3,$4,$5,$6, now() + make_interval(secs => $7), $8, now(), null, now())
    on conflict (user_id) do update set ms_user_id = excluded.ms_user_id, ms_email = excluded.ms_email, ms_name = excluded.ms_name,
      refresh_token_enc = excluded.refresh_token_enc, access_token_enc = excluded.access_token_enc, access_expires_at = excluded.access_expires_at,
      scope = excluded.scope, connected_at = now(), delta_link = null, last_error = null, updated_at = now()`,
    [actor.id, m.id, email, m.displayName ?? null, seal(t.refresh_token), seal(t.access_token), Math.max(60, Number(t.expires_in) - 120), t.scope ?? SCOPES]);
  await audit(pool(), actor, { entity_type: 'user', entity_id: actor.id, action: 'Outlook connected', new_value: email, sensitivity: 'admin' });
  return { ok: true, email };
}

export async function disconnect(actor: Actor, userId?: string) {
  const id = userId || actor.id;
  if (id !== actor.id && !actor.isSuperAdmin && !actor.has('users.manage')) throw forbidden();
  const c = await one('delete from outlook_connections where user_id = $1 returning ms_email', [id]);
  if (c) await audit(pool(), actor, { entity_type: 'user', entity_id: id, action: 'Outlook disconnected', old_value: c.ms_email, sensitivity: 'admin' });
  return { ok: true };
}

// ---------------------------------------------------------------- calling Microsoft for a connected person (used by the next steps)
/** A valid access token for this person, refreshed when it is about to run out. */
export async function accessToken(userId: string) {
  const c = await one('select * from outlook_connections where user_id = $1', [userId]);
  if (!c) throw new ApiError(409, 'NOT_CONNECTED', 'Outlook is not connected');
  if (c.access_token_enc && c.access_expires_at && new Date(c.access_expires_at).getTime() > Date.now() + 60_000) return unseal(c.access_token_enc);
  try {
    const t = await tokenCall({ grant_type: 'refresh_token', refresh_token: unseal(c.refresh_token_enc) });
    await q(`update outlook_connections set access_token_enc = $2, access_expires_at = now() + make_interval(secs => $3),
        refresh_token_enc = coalesce($4, refresh_token_enc), last_error = null, updated_at = now() where user_id = $1`,
      [userId, seal(t.access_token), Math.max(60, Number(t.expires_in) - 120), t.refresh_token ? seal(t.refresh_token) : null]);
    return t.access_token;
  } catch (e: any) {
    await q('update outlook_connections set last_error = $2, updated_at = now() where user_id = $1', [userId, 'Microsoft asked to sign in again — press Connect']);
    throw new ApiError(409, 'RECONNECT', 'Please connect Outlook again (Microsoft asked to sign in again)');
  }
}

/** One Microsoft Graph call for this person. */
export async function graph(userId: string, path: string, init: RequestInit = {}) {
  const token = await accessToken(userId);
  let res: Response;
  try {
    res = await net(path.startsWith('https://') ? path : `https://graph.microsoft.com/v1.0${path}`, {
      ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(init.headers ?? {}) },
    });
  } catch { throw new ApiError(502, 'MS_UNREACHABLE', 'Could not reach Microsoft just now. Try again in a minute.'); }
  if (res.status === 202 || res.status === 204) return null;
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(502, 'MS_GRAPH', `Outlook: ${j?.error?.message ?? res.statusText}`.slice(0, 300));
  return j;
}

// ---------------------------------------------------------------- Step 2: sending from the person's own Outlook
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Is this person's Outlook ready to send? (pilot user + connected) */
export async function canSend(userId: string) {
  if (!config().ready || !(await isPilot(userId))) return false;
  return !!(await one('select 1 from outlook_connections where user_id = $1', [userId]));
}

/**
 * Send one email from this person's own mailbox. It lands in their Sent Items like any email they write.
 * Plain text only; the addresses are checked here again.
 */
export async function sendMail(userId: string, m: { to: string[]; cc?: string[]; subject: string; body: string }) {
  if (!(await isPilot(userId))) throw forbidden('Outlook is only for the pilot users for now');
  const clean = (l?: string[]) => [...new Set((l ?? []).map((x) => String(x).trim().toLowerCase()).filter((x) => EMAIL_RE.test(x)))].slice(0, 20);
  const to = clean(m.to), cc = clean(m.cc).filter((x) => !to.includes(x));
  if (!to.length) throw new ApiError(400, 'VALIDATION', 'Choose or type at least one email address');
  const subject = String(m.subject ?? '').trim().slice(0, 300);
  if (!subject) throw new ApiError(400, 'VALIDATION', 'The email needs a subject');
  const addr = (a: string) => ({ emailAddress: { address: a } });
  await graph(userId, '/me/sendMail', { method: 'POST', body: JSON.stringify({
    message: { subject, body: { contentType: 'Text', content: String(m.body ?? '').slice(0, 100_000) }, toRecipients: to.map(addr), ccRecipients: cc.map(addr) },
    saveToSentItems: true,
  }) });
  const from = await one('select ms_email from outlook_connections where user_id = $1', [userId]);
  return { to, cc, subject, from: from?.ms_email as string | null };
}
