'use client';
import { useEffect, useState } from 'react';
import { api } from './api';

let outlookState: Promise<any> | null = null;
const outlook = () => (outlookState ??= api('/api/outlook').catch(() => { outlookState = null; return {}; }));

/**
 * "Email all from my Outlook": the rate request goes to every agent in this group that has not answered yet — one email each
 * (agents never see each other), from your own Outlook, each noted on its request. Only for connected Outlook pilot users.
 */
export function SendAllRates({ requests, onDone }: { requests: any[]; onDone: () => void }) {
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ t: 'ok' | 'err'; m: string } | null>(null);
  useEffect(() => { outlook().then((s) => setOk(!!(s?.configured && s?.pilot && s?.connected && !s?.last_error))); }, []);
  const waiting = requests.filter((r) => r.status === 'requested');
  if (!ok || waiting.length < 2) return null;
  const run = async () => {
    if (!confirm(`Email the rate request to ${waiting.length} agents from your Outlook? Each agent gets their own email.`)) return;
    const sent: string[] = [], failed: string[] = [];
    for (const r of waiting) {
      setBusy(`${sent.length + failed.length + 1} of ${waiting.length}`);
      try {
        const d = await api(`/api/email-draft?${new URLSearchParams({ kind: 'vendor_request', id: r.id })}`);
        const to = d.recipients.filter((x: any) => x.picked && x.place !== 'cc').map((x: any) => x.email);
        const cc = d.recipients.filter((x: any) => x.picked && x.place === 'cc').map((x: any) => x.email);
        if (!to.length) { failed.push(`${r.vendor_name} (no email saved)`); continue; }
        await api('/api/email-send', { body: { kind: 'vendor_request', id: r.id, update: d.update, to, cc, subject: d.subject, body: d.body } });
        sent.push(r.vendor_name);
      } catch (e: any) { failed.push(`${r.vendor_name} (${e.message})`); }
    }
    setBusy(null);
    setMsg(failed.length ? { t: 'err', m: `Sent to ${sent.length}. Not sent: ${failed.join('; ')}` } : { t: 'ok', m: `Sent to all ${sent.length} agents from your Outlook.` });
    onDone();
  };
  return <>
    <button className="linkish" disabled={!!busy} onClick={run}>{busy ? `Sending ${busy}…` : `Email all ${waiting.length} from my Outlook`}</button>
    {msg && <span className={`small ${msg.t === 'err' ? 'flag' : 'muted'}`} style={{ marginLeft: 6 }}>{msg.m}</span>}
  </>;
}
