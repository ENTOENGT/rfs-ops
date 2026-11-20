/**
 * Migration 034 — agent coverage: where each agent works, and which agents to ask for an enquiry's rate.
 *
 * Coverage is a port, a country or a region (your group of countries), optionally only some modes (FCL / LCL / Air…), for the
 * origin side, the destination side or both, with a priority (1 preferred, 2 normal, 3 backup).
 *
 * For an enquiry, each end that is not in the UAE (origin for imports, destination for exports, both for cross trade) gets
 * every agent that covers it: the enquiry's own port first, then any other port in the same country and the country itself
 * (so "collection in Germany" asks every German agent), then the regions that include that country.
 */
import { Actor } from './auth';
import { audit, bad, forbidden, notFound, one, pool, q } from './db';
import { ensurePortsLoaded } from './ports';

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const HOME_COUNTRY = 'AE';
const MODES = ['sea_fcl', 'sea_lcl', 'air', 'road', 'courier', 'other'];
export const canManageCoverage = (a: Actor) => a.isSuperAdmin || a.has('vendors.manage') || a.has('commercial.manage');
const canSee = (a: Actor) => canManageCoverage(a) || a.has('vendors.requests');

export async function listCoverage(actor: Actor, vendorId: string) {
  if (!canSee(actor)) throw forbidden();
  if (!isUuid(vendorId)) throw notFound('Vendor');
  const v = await one('select id, name, email, vendor_type from vendors where id = $1 and deleted_at is null', [vendorId]);
  if (!v) throw notFound('Vendor');
  await ensurePortsLoaded();
  const rows = await q(`select a.*, p.name port_name, pc.name port_country, c.name country_name, r.name region_name
      from agent_coverage a left join ports p on p.code = a.port_code left join countries pc on pc.code = p.country_code
      left join countries c on c.code = a.country_code left join regions r on r.id = a.region_id
     where a.vendor_id = $1 order by a.priority, a.scope, coalesce(p.name, c.name, r.name)`, [vendorId]);
  return { vendor: v, rows, can_manage: canManageCoverage(actor) };
}

export async function saveCoverage(actor: Actor, vendorId: string, b: any) {
  if (!canManageCoverage(actor)) throw forbidden('Only the Super Admin, the Commercials Manager or whoever manages vendors changes agent coverage');
  if (!isUuid(vendorId)) throw notFound('Vendor');
  const v = await one('select name from vendors where id = $1 and deleted_at is null', [vendorId]);
  if (!v) throw notFound('Vendor');
  if (b.remove) {
    if (!isUuid(b.id)) throw notFound('Coverage');
    const r = await one('delete from agent_coverage where id = $1 and vendor_id = $2 returning id', [b.id, vendorId]);
    if (!r) throw notFound('Coverage');
    await audit(pool(), actor, { entity_type: 'vendor', entity_id: vendorId, action: 'Agent coverage removed', new_value: v.name, sensitivity: 'admin' });
    return listCoverage(actor, vendorId);
  }
  await ensurePortsLoaded();
  const scope = String(b.scope ?? '');
  let port: string | null = null, country: string | null = null, region: string | null = null, label = '';
  if (scope === 'port') {
    const p = await one('select code, name from ports where code = upper($1)', [String(b.port_code ?? '')]);
    if (!p) throw bad('Choose the port from the list'); port = p.code; label = p.name;
  } else if (scope === 'country') {
    const c = await one('select code, name from countries where code = upper($1)', [String(b.country_code ?? '')]);
    if (!c) throw bad('Choose the country'); country = c.code; label = c.name;
  } else if (scope === 'region') {
    if (!isUuid(b.region_id)) throw bad('Choose the region');
    const r = await one('select id, name from regions where id = $1', [b.region_id]);
    if (!r) throw bad('Choose the region'); region = r.id; label = r.name;
  } else throw bad('Choose port, country or region');
  const modes = [...new Set((Array.isArray(b.modes) ? b.modes : []).map(String))].filter((m) => MODES.includes(m as string));
  const side = ['origin', 'destination', 'both'].includes(b.side) ? b.side : 'both';
  const priority = [1, 2, 3].includes(Number(b.priority)) ? Number(b.priority) : 2;
  const note = String(b.note ?? '').trim().slice(0, 200) || null;
  const dup = await one(`select id from agent_coverage where vendor_id = $1 and scope = $2 and port_code is not distinct from $3 and country_code is not distinct from $4
      and region_id is not distinct from $5 and ($6::uuid is null or id <> $6)`, [vendorId, scope, port, country, region, isUuid(b.id) ? b.id : null]);
  if (dup) throw bad(`${label} is already in this agent's coverage`);
  if (isUuid(b.id)) {
    const r = await one(`update agent_coverage set scope = $3, port_code = $4, country_code = $5, region_id = $6, modes = $7, side = $8, priority = $9, note = $10
      where id = $1 and vendor_id = $2 returning id`, [b.id, vendorId, scope, port, country, region, modes, side, priority, note]);
    if (!r) throw notFound('Coverage');
  } else {
    await q(`insert into agent_coverage (vendor_id, scope, port_code, country_code, region_id, modes, side, priority, note, created_by)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`, [vendorId, scope, port, country, region, modes, side, priority, note, actor.id]);
  }
  await audit(pool(), actor, { entity_type: 'vendor', entity_id: vendorId, action: 'Agent coverage saved', new_value: `${v.name}: ${scope} ${label}`, sensitivity: 'admin' });
  return listCoverage(actor, vendorId);
}

/** The agents to ask for this enquiry's rate, for each end that is abroad. */
export async function suggestAgents(actor: Actor, fileId: string) {
  if (!canSee(actor)) throw forbidden();
  const { loadFile } = await import('./jobfiles');
  const f = await loadFile(actor, fileId);
  await ensurePortsLoaded();
  const ends: any[] = [];
  for (const end of ['origin', 'destination'] as const) {
    const portCode = end === 'origin' ? f.pol_code : f.pod_code;
    const port = portCode ? await one(`select p.code, p.name, p.country_code from ports p where p.code = $1`, [portCode]) : null;
    const country: string | null = (end === 'origin' ? f.origin_country : f.destination_country) || port?.country_code || null;
    if (!country || country === HOME_COUNTRY) continue;
    const cname = (await one('select name from countries where code = $1', [country]))?.name ?? country;
    const rows = await q(`select distinct on (v.id) v.id vendor_id, v.name, v.email, a.priority, a.note,
        case when a.scope = 'port' and a.port_code = $1 then 1 when a.scope = 'port' or a.scope = 'country' then 2 else 3 end rank,
        case when a.scope = 'port' then 'Port: ' || p.name when a.scope = 'country' then 'Country: ' || c.name else 'Region: ' || r.name end matched
      from agent_coverage a join vendors v on v.id = a.vendor_id and v.deleted_at is null and v.is_active
        left join ports p on p.code = a.port_code left join countries c on c.code = a.country_code left join regions r on r.id = a.region_id
      where a.side in ($3, 'both') and (cardinality(a.modes) = 0 or $4 = any(a.modes))
        and ((a.scope = 'port' and p.country_code = $2) or (a.scope = 'country' and a.country_code = $2)
          or (a.scope = 'region' and r.is_active and $2 = any(r.countries)))
      order by v.id, rank, a.priority`, [port?.code ?? null, country, end, f.mode ?? '']);
    rows.sort((a, b) => a.rank - b.rank || a.priority - b.priority || String(a.name).localeCompare(String(b.name)));
    ends.push({ end, country_code: country, country_name: cname, port_code: port?.code ?? null, port_name: port?.name ?? null,
      label: `${end === 'origin' ? 'Origin' : 'Destination'}: ${port ? `${port.name}, ` : ''}${cname}${port ? '' : ' (any port)'}`, agents: rows });
  }
  return { ends };
}
