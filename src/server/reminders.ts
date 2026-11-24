/**
 * 24 Nov (migration 042) — shipment reminders, every hour (netlify/functions/shipment-reminders.mjs), to the people handling
 * the shipment (coordinator, salesman, CS / ops / docs handlers — the bell and the Notifications page):
 *   etd_passed   ETD has passed and nobody has said it sailed (once per ETD — a new ETD after a roll-over reminds again)
 *   eta_soon     arriving within 2 days and not arrived yet (once per ETA)
 *   eta_changed  the ETA on the shipment moved, and the team was not already told (vessel / ETA change) in the last hours
 *   cutoff_soon  an SI / VGM / gate-in cut-off is tomorrow and the vessel has not sailed (once per cut-off)
 * Each reminder is kept in shipment_reminders, so it is never sent twice. Only live shipments (not closed, cancelled or lost).
 */
import { one, q, tx } from './db';
import { notifyGroup } from './notify';

const dubai = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dubai' });
const plus = (day: string, n: number) => { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const fmt = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', timeZone: 'UTC' });

/** Once: true the first time this (shipment, kind, date) is seen. */
async function once(c: any, fileId: string, kind: string, forDate: string | null) {
  const r = await c.query(`insert into shipment_reminders (job_file_id, kind, for_date) values ($1, $2, $3) on conflict do nothing`, [fileId, kind, forDate]);
  return (r.rowCount ?? 0) > 0;
}

export async function runShipmentReminders(today = dubai()) {
  const live = `f.deleted_at is null and f.status not in ('closed', 'cancelled') and coalesce(f.stage, '') <> 'lost'
    and (f.booking_reference is not null or f.vessel_flight is not null)`;
  const rows = await q(`select f.id, to_char(f.etd, 'YYYY-MM-DD') etd, to_char(f.eta, 'YYYY-MM-DD') eta, f.atd, f.ata, f.vessel_flight, f.voyage, f.mode,
      to_char(f.cutoff_si, 'YYYY-MM-DD HH24:MI') cutoff_si, to_char(f.cutoff_vgm, 'YYYY-MM-DD HH24:MI') cutoff_vgm, to_char(f.cutoff_gate, 'YYYY-MM-DD HH24:MI') cutoff_gate
    from job_files f where ${live} limit 2000`);
  const sent: Record<string, number> = { etd_passed: 0, eta_soon: 0, eta_changed: 0, cutoff_soon: 0 };
  for (const f of rows) {
    await tx(async (c) => {
      const what = f.mode === 'air' ? 'flight' : 'vessel';
      const name = [f.vessel_flight, f.voyage].filter(Boolean).join(' ');
      if (f.etd && f.etd < today && !f.atd && await once(c, f.id, 'etd_passed', f.etd)) {
        await notifyGroup(c, null, f.id, 'etd_passed', `ETD was ${fmt(f.etd)}${name ? ` (${name})` : ''}: confirm it ${f.mode === 'air' ? 'departed' : 'sailed'} or get the new ETD`); sent.etd_passed++;
      }
      if (f.eta && !f.ata && f.eta >= today && f.eta <= plus(today, 2) && await once(c, f.id, 'eta_soon', f.eta)) {
        await notifyGroup(c, null, f.id, 'eta_soon', `ETA ${fmt(f.eta)}${name ? ` — ${what} ${name}` : ''}`); sent.eta_soon++;
      }
      if (f.eta && !f.ata) {
        const last = await one(`select to_char(for_date, 'YYYY-MM-DD') d from shipment_reminders where job_file_id = $1 and kind = 'eta' order by created_at desc limit 1`, [f.id], c);
        if (await once(c, f.id, 'eta', f.eta) && last?.d && last.d !== f.eta) {
          // already told by the vessel step / the AI booking reader?
          const told = await one(`select 1 from notifications where job_file_id = $1 and event in ('vessel_changed', 'eta_changed') and created_at > now() - interval '6 hours' limit 1`, [f.id], c);
          if (!told) { await notifyGroup(c, null, f.id, 'eta_changed', `from ${fmt(last.d)} to ${fmt(f.eta)}`); sent.eta_changed++; }
        }
      }
      if (!f.atd) for (const [k, label] of [['cutoff_si', 'SI / documents'], ['cutoff_vgm', 'VGM'], ['cutoff_gate', 'port / gate-in']] as const) {
        const v: string | null = f[k];
        if (v && v.slice(0, 10) === plus(today, 1) && await once(c, f.id, `cutoff_${k}`, v.slice(0, 10))) {
          await notifyGroup(c, null, f.id, 'cutoff_soon', `${label} cut-off ${fmt(v.slice(0, 10))} ${v.slice(11)}`); sent.cutoff_soon++;
        }
      }
    });
  }
  return { checked: rows.length, sent };
}
