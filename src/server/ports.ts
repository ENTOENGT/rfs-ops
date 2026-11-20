/**
 * Migration 034 — ports & airports, countries and your regions.
 * The UN/LOCODE list (src/data/ports.json: about 17,600 seaports and 9,100 airports in 249 countries) is loaded into the
 * database by the app the first time anyone searches a port, so nobody has to paste 25,000 rows into the SQL editor.
 */
import { Actor } from './auth';
import { audit, bad, forbidden, notFound, one, pool, q } from './db';

const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
export const canManagePlaces = (a: Actor) => a.isSuperAdmin || a.has('settings.manage') || a.has('commercial.manage');

let loaded = false;
/** Load the world list once (safe to run again: nothing is duplicated, your own ports and changes stay). */
export async function ensurePortsLoaded() {
  if (loaded) return;
  if (await one('select 1 from ports where not is_custom and weight > 0 limit 1')) { loaded = true; return; }
  const data: any = (await import('../data/ports.json')).default;
  const c = await pool().connect();
  try {
    await c.query('begin');
    await c.query(`insert into countries (code, name) select * from unnest($1::text[], $2::text[]) on conflict (code) do nothing`,
      [data.countries.map((x: any) => x[0]), data.countries.map((x: any) => x[1])]);
    for (let i = 0; i < data.ports.length; i += 3000) {
      const part = data.ports.slice(i, i + 3000);
      await c.query(`insert into ports (code, name, country_code, kind, iata, plain_name, weight)
          select code, name, cc, kind, nullif(iata, ''), nullif(plain, ''), w from unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::int[])
            as t(code, name, cc, kind, iata, plain, w)
        on conflict (code) do update set weight = excluded.weight where not ports.is_custom`,
        [...[0, 1, 2, 3, 4, 5].map((k) => part.map((x: any) => x[k] ?? '')), part.map((x: any) => Number(x[6]) || 1)]);
    }
    await c.query('commit');
    loaded = true;
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
}

/** Port / airport search by code, airport code or name. `kind`: sea / air (both also matches); `country` comes first, others still show. */
export async function searchPorts(_actor: Actor, p: Record<string, string>) {
  await ensurePortsLoaded();
  const text = String(p.q ?? '').trim();
  if (text.length < 2) return { rows: [] };
  const kind = ['sea', 'air'].includes(p.kind) ? p.kind : null;
  const country = /^[A-Z]{2}$/i.test(p.country ?? '') ? p.country.toUpperCase() : null;
  const t = text.toLowerCase();
  const rows = await q(`select p.code, p.name, p.country_code, c.name country_name, p.kind, p.iata, p.is_custom from ports p
      left join countries c on c.code = p.country_code
     where p.is_active and ($2::text is null or p.kind in ($2, 'both') or (p.kind = 'inland' and $2 = 'sea'))
       and (lower(p.code) = $1 or lower(p.iata) = $1 or lower(p.name) like $1 || '%' or lower(p.plain_name) like $1 || '%'
            or lower(p.name) like '% ' || $1 || '%' or (length($1) >= 4 and lower(p.name) like '%' || $1 || '%'))
     order by coalesce(lower(p.code) = $1 or lower(p.iata) = $1, false) desc, coalesce(p.country_code = $3, false) desc, (lower(p.name) = $1) desc,
       coalesce(lower(p.name) like $1 || '%' or lower(p.plain_name) like $1 || '%', false) desc,
       p.is_custom desc, p.weight desc, (p.country_code = 'AE') desc, length(p.name), p.name
     limit 20`, [t, kind, country]);
  return { rows };
}

export async function listCountries() {
  await ensurePortsLoaded();
  return { rows: await q('select code, name from countries order by name') };
}

/** One port by code (with its country), or null. */
export async function portByCode(code: unknown) {
  if (typeof code !== 'string' || !/^[A-Z0-9]{5}$/i.test(code)) return null;
  await ensurePortsLoaded();
  return one(`select p.code, p.name, p.country_code, c.name country_name, p.kind, p.iata from ports p left join countries c on c.code = p.country_code
    where p.code = upper($1)`, [code]);
}

// ---------------------------------------------------------------- regions (your own groups of countries)
export async function listRegions(actor: Actor) {
  await ensurePortsLoaded();
  const rows = await q(`select r.id, r.name, r.countries, r.is_active,
      (select coalesce(json_agg(json_build_object('code', c.code, 'name', c.name) order by c.name), '[]') from countries c where c.code = any(r.countries)) country_list
    from regions r order by r.is_active desc, r.name`);
  return { rows, can_manage: canManagePlaces(actor) };
}

export async function saveRegion(actor: Actor, b: any) {
  if (!canManagePlaces(actor)) throw forbidden('Only the Super Admin or the Commercials Manager changes regions');
  const name = String(b.name ?? '').trim();
  if (!name || name.length > 60) throw bad('Give the region a name (up to 60 characters)');
  const codes = [...new Set((Array.isArray(b.countries) ? b.countries : []).map((x: unknown) => String(x).toUpperCase()))].filter((x) => /^[A-Z]{2}$/.test(x as string)) as string[];
  if (!codes.length) throw bad('Choose at least one country');
  const known = await q('select code from countries where code = any($1)', [codes]);
  if (known.length !== codes.length) throw bad('One of the countries is not in the list');
  const active = b.is_active !== false;
  if (b.id) {
    if (!isUuid(b.id)) throw notFound('Region');
    const r = await one(`update regions set name = $2, countries = $3, is_active = $4, updated_by = $5, updated_at = now() where id = $1 returning id`, [b.id, name, codes, active, actor.id])
      .catch((e) => { if (e.code === '23505') throw bad('A region with this name already exists'); throw e; });
    if (!r) throw notFound('Region');
  } else {
    await q(`insert into regions (name, countries, is_active, updated_by) values ($1, $2, $3, $4)`, [name, codes, active, actor.id])
      .catch((e) => { if (e.code === '23505') throw bad('A region with this name already exists'); throw e; });
  }
  await audit(pool(), actor, { entity_type: 'setting', entity_id: null, action: b.id ? 'Region changed' : 'Region added', new_value: `${name}: ${codes.join(', ')}`, sensitivity: 'admin' });
  return listRegions(actor);
}

/** Your own port / inland depot / ICD that is not in the UN list. */
export async function addPort(actor: Actor, b: any) {
  if (!canManagePlaces(actor)) throw forbidden('Only the Super Admin or the Commercials Manager adds ports');
  await ensurePortsLoaded();
  const name = String(b.name ?? '').trim();
  if (!name || name.length > 80) throw bad('Type the port name');
  const country = String(b.country_code ?? '').toUpperCase();
  if (!(await one('select 1 from countries where code = $1', [country]))) throw bad('Choose the country');
  const kind = ['sea', 'air', 'both', 'inland'].includes(b.kind) ? b.kind : 'sea';
  let code = String(b.code ?? '').trim().toUpperCase();
  if (code && !/^[A-Z]{2}[A-Z0-9]{3}$/.test(code)) throw bad('The code is 2 letters of the country and 3 letters or numbers, e.g. AEJXB');
  if (code && code.slice(0, 2) !== country) throw bad(`The code must start with ${country}`);
  if (!code) for (let i = 0; i < 50 && !code; i++) {
    const c = `${country}${String.fromCharCode(88)}${String(i).padStart(2, '0')}`;   // e.g. AEX00 — "X" codes are not used by the UN list
    if (!(await one('select 1 from ports where code = $1', [c]))) code = c;
  }
  if (await one('select 1 from ports where code = $1', [code])) throw bad(`${code} already exists`);
  await q(`insert into ports (code, name, plain_name, country_code, kind, is_custom) values ($1, $2, $2, $3, $4, true)`, [code, name, country, kind]);
  await audit(pool(), actor, { entity_type: 'setting', entity_id: null, action: 'Port added', new_value: `${code} ${name}`, sensitivity: 'admin' });
  return portByCode(code);
}
