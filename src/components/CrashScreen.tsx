'use client';
import { useEffect } from 'react';

/** After a new version is deployed, a page that was already open asks for files that no longer exist. A reload fixes it. */
const isOldVersion = (e: any) => /ChunkLoadError|Loading (CSS )?chunk|dynamically imported module|Importing a module script failed/i.test(`${e?.name} ${e?.message}`);

/**
 * 27 Nov: instead of Next.js's bare "Application error", say what happened and offer a way out.
 * An outdated page reloads by itself once; any other error is shown so it can be sent to support.
 */
export function CrashScreen({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const old = isOldVersion(error);
  useEffect(() => {
    console.error(error);
    if (!old) return;
    try {
      const last = Number(sessionStorage.getItem('rfs.reloaded') || 0);
      if (Date.now() - last > 30_000) { sessionStorage.setItem('rfs.reloaded', String(Date.now())); window.location.reload(); }   // once, never in a loop
    } catch { window.location.reload(); }
  }, [error, old]);
  return (
    <div className="page" role="alert">
      <div className="panel" style={{ maxWidth: 640 }}>
        <h2 style={{ marginTop: 0 }}>{old ? 'A new version of RFS CRM is ready' : 'This page hit a problem'}</h2>
        <p>{old ? 'The page is reloading to get it. If it does not, press Reload page.'
          : 'Nothing you saved is lost. Press Try again; if it happens again, send a screenshot of this box to support.'}</p>
        {!old && <p className="small muted" style={{ wordBreak: 'break-word' }}>Error: {error?.message || 'unknown'}{error?.digest ? ` (ref. ${error.digest})` : ''} · {typeof window !== 'undefined' ? window.location.pathname : ''}</p>}
        <div className="actions" style={{ justifyContent: 'flex-start' }}>
          {!old && <button className="btn primary" onClick={reset}>Try again</button>}
          <button className="btn" onClick={() => window.location.reload()}>Reload page</button>
        </div>
      </div>
    </div>
  );
}
