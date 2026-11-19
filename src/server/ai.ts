/**
 * AI agent — the connection to Claude (Anthropic API).
 *
 *  - Settings (Netlify environment, never in the code): ANTHROPIC_API_KEY; AI_MODEL is optional (default claude-haiku-5-5,
 *    Anthropic's fastest model, made for reading details out of text).
 *  - Every call forces one "tool", so the answer always comes back in a fixed shape (no free text to interpret).
 *  - The AI only suggests. Nothing it returns is saved on a shipment until a person ticks it and presses Apply.
 */
import { ApiError } from './db';

export const DEFAULT_MODEL = 'claude-haiku-5-5';
const TIMEOUT_MS = 8000;           // the hosting cuts requests at 10 seconds

/** Tests replace the network with a fake Claude. */
let net: typeof fetch = (...a) => fetch(...a);
export const setAiNetwork = (f: typeof fetch) => { net = f; };

export function aiConfig() {
  const key = process.env.ANTHROPIC_API_KEY;
  return { ready: !!key && key.length > 20, key, model: process.env.AI_MODEL || DEFAULT_MODEL };
}

export type Tool = { name: string; description: string; input_schema: Record<string, unknown> };

/** One call to Claude that must answer by filling in `tool`. Returns the filled-in object and the model used. */
export async function askWithTool(system: string, user: string, tool: Tool, maxTokens = 1500): Promise<{ input: any; model: string }> {
  const c = aiConfig();
  if (!c.ready) throw new ApiError(503, 'AI_NOT_SET_UP', 'The AI agent is not switched on yet (the Anthropic key is missing in the hosting settings)');
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await net('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': c.key!, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: c.model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }],
        tools: [tool], tool_choice: { type: 'tool', name: tool.name } }),
    });
  } catch (e: any) {
    throw new ApiError(502, 'AI_UNREACHABLE', e?.name === 'AbortError' ? 'The AI took too long to answer. Try again.' : 'Could not reach the AI just now. Try again in a minute.');
  } finally { clearTimeout(timer); }
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) throw new ApiError(502, 'AI_KEY', 'The Anthropic key is not valid. Check ANTHROPIC_API_KEY in the hosting settings.');
    if (res.status === 429 || res.status === 529) throw new ApiError(503, 'AI_BUSY', 'The AI is busy right now. Try again in a minute.');
    if (res.status === 400 && /credit|billing/i.test(String(j?.error?.message))) throw new ApiError(502, 'AI_BILLING', 'The Anthropic account has no credit left. Ask whoever manages it to add credit.');
    throw new ApiError(502, 'AI_ERROR', `The AI could not answer: ${String(j?.error?.message ?? res.statusText).slice(0, 200)}`);
  }
  const block = (j.content ?? []).find((b: any) => b.type === 'tool_use' && b.name === tool.name);
  if (!block?.input) throw new ApiError(502, 'AI_ERROR', 'The AI answer was not complete. Try again.');
  return { input: block.input, model: String(j.model ?? c.model) };
}
