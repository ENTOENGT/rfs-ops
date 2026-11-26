// Netlify scheduled function (24 Nov): every 2 minutes, check the connected Outlook inboxes in the background, so a new
// enquiry comes into RFS CRM even when nobody has it open. Netlify runs this by itself on the published site.
// Each call to the app takes up to ~7 seconds; while it says "more", call again (at most 3 times, under Netlify's 30 seconds).
// The app checks the key (made from SESSION_SECRET) before doing anything.
import { createHmac } from 'node:crypto';

export default async () => {
  const key = createHmac('sha256', process.env.SESSION_SECRET || '').update('inbox-check').digest('hex');
  let last = '', status = 200;
  for (let i = 0; i < 3; i++) {
    const res = await fetch(`${process.env.URL}/api/cron/inbox-check`, { method: 'POST', headers: { 'x-cron-key': key } });
    status = res.status; last = await res.text();
    let more = false;
    try { more = !!JSON.parse(last).more; } catch { /* not JSON: stop */ }
    if (!res.ok || !more) break;
  }
  console.log('Inbox check', status, last.slice(0, 300));
  // then the AI's background reading (vendor / booking replies, new-enquiry forms), a separate call so each stays short
  const rd = await fetch(`${process.env.URL}/api/cron/inbox-check?phase=read`, { method: 'POST', headers: { 'x-cron-key': key } }).catch(() => null);
  if (rd) console.log('Background reading', rd.status, (await rd.text()).slice(0, 300));
  return new Response(last, { status });
};

export const config = { schedule: '*/2 * * * *' };
