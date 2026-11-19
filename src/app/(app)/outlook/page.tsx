'use client';
/** G3 step 1 (migration 029): "My Outlook" — connect or disconnect your own Outlook mailbox (pilot users). */
import { useEffect, useState } from 'react';
import { api, fmtDateTime } from '@/components/api';

export default function MyOutlook() {
  const [s, setS] = useState<any>(null);
  const [note, setNote] = useState<{ t: 'ok' | 'err'; m: string } | null>(null);
  const load = () => api('/api/outlook').then(setS).catch((e) => setNote({ t: 'err', m: e.message }));
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('connected')) setNote({ t: 'ok', m: `Outlook connected: ${p.get('connected')}` });
    if (p.get('error')) setNote({ t: 'err', m: p.get('error')! });
    if (p.get('connected') || p.get('error')) window.history.replaceState(null, '', '/outlook');
    load();
  }, []);
  const off = async () => {
    if (!confirm('Disconnect your Outlook from RFS CRM? You can connect again at any time.')) return;
    try { await api('/api/outlook', { method: 'DELETE' }); setNote({ t: 'ok', m: 'Outlook disconnected.' }); load(); } catch (e: any) { setNote({ t: 'err', m: e.message }); }
  };
  return (
    <div className="page" style={{ maxWidth: 760 }}>
      <div className="page-head"><h1>My Outlook</h1></div>
      {note && <div className={`msg ${note.t}`}>{note.m}</div>}
      {!s ? <p className="muted">Loading…</p> : <div className="panel">
        {!s.configured ? <p>The Outlook connection is not switched on yet. The Super Admin adds the Microsoft details in the hosting settings.</p>
          : !s.pilot ? <p>Outlook is open to the pilot users only for now. Ask the Super Admin if you should be one of them.</p>
          : s.connected ? <>
            <p style={{ marginTop: 0 }}><b>Connected:</b> {s.ms_email}{s.ms_name ? ` (${s.ms_name})` : ''}<br />
              <span className="muted small">Since {fmtDateTime(s.connected_at)}{s.last_sync_at ? ` · last checked ${fmtDateTime(s.last_sync_at)}` : ''}</span></p>
            {s.last_error && <div className="msg warn">{s.last_error}</div>}
            <div style={{ display: 'flex', gap: 8 }}>
              {s.last_error && <a className="btn primary" href="/api/outlook/connect">Connect again</a>}
              <button className="btn danger" onClick={off}>Disconnect</button></div>
          </> : <>
            <p style={{ marginTop: 0 }}>Connect your Outlook once. RFS CRM will then be able to send the emails you prepare from your own mailbox, and file the replies on the right shipment.</p>
            <ul className="muted small" style={{ lineHeight: 1.7 }}>
              <li>Only <b>your</b> mailbox, with your own Microsoft permissions — nobody else's.</li>
              <li>Nothing is sent without you pressing Send.</li>
              <li>You can disconnect here at any time; IT can also switch it off.</li>
            </ul>
            <a className="btn primary" href="/api/outlook/connect">Connect my Outlook</a>
          </>}
      </div>}
    </div>
  );
}
