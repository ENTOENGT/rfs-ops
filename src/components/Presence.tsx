'use client';
/** Release L (migration 027): a small coloured dot for a person's live status, with the details in its tooltip. */
export const STATUS: Record<string, [string, string]> = {
  online: ['Online', '#2F9E5B'], away: ['Away', '#D69E2E'], busy: ['Busy', '#C53030'], leave: ['On leave', '#8A94A6'], offline: ['Offline', '#B8BEC6'],
};
const ago = (iso: string | null | undefined) => {
  if (!iso) return 'not seen yet';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 60 ? `last seen ${m} min ago` : m < 1440 ? `last seen ${Math.round(m / 60)} h ago` : `last seen ${new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`;
};
export function statusText(s: any) {
  if (!s?.status) return '';
  const [name] = STATUS[s.status] ?? ['', ''];
  if (s.status === 'leave') return `On leave${s.leave_until ? ` until ${new Date(s.leave_until).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}` : ''}${s.status_note ? ` — ${s.status_note}` : ''}`;
  if (s.status === 'busy') return `Busy${s.status_note ? ` — ${s.status_note}` : ''}`;
  if (s.status === 'offline') return `Offline — ${ago(s.last_seen_at)}`;
  return name;
}
export function StatusDot({ s, label }: { s: any; label?: boolean }) {
  if (!s?.status) return null;
  const [, color] = STATUS[s.status] ?? STATUS.offline;
  const t = statusText(s);
  return <span className="sdot-wrap" title={t}><span className="sdot" style={{ background: color }} role="img" aria-label={t} />{label && <span className="muted small">{t}</span>}</span>;
}
