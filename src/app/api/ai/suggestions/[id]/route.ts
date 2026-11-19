import { requireActor } from '@/server/auth';
import { applySuggestion, dismissSuggestion } from '@/server/agent';
import { route, body } from '@/server/http';
/** AI agent: { action: 'apply', keys: [...] } fills the ticked answers in; { action: 'dismiss' } closes the suggestion. */
export const POST = route(async (req, { params }) => {
  const actor = await requireActor(req);
  const b = await body(req);
  return b.action === 'dismiss' ? dismissSuggestion(actor, params.id) : applySuggestion(actor, params.id, b);
});
