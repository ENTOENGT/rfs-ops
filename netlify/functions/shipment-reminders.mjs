// Netlify scheduled function (24 Nov, migration 042): every hour, ask RFS CRM to send the shipment reminders
// (ETD passed without sailing, arriving in 2 days, ETA changed, cut-off tomorrow) to the people handling each shipment.
// Netlify runs this by itself on the published site — nothing to start by hand.
// The app checks the key (made from SESSION_SECRET) before doing anything.
import { createHmac } from 'node:crypto';

export default async () => {
  const site = process.env.URL;
  const key = createHmac('sha256', process.env.SESSION_SECRET || '').update('shipment-reminders').digest('hex');
  const res = await fetch(`${site}/api/cron/shipment-reminders`, { method: 'POST', headers: { 'x-cron-key': key } });
  const text = await res.text();
  console.log('Shipment reminders', res.status, text.slice(0, 300));
  return new Response(text, { status: res.status });
};

export const config = { schedule: '@hourly' };
