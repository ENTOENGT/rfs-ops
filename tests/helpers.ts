import { readFileSync, readdirSync } from 'fs';
import { pool } from '../src/server/db';
/**
 * The tests DELETE EVERY TABLE before they start. They only run on a database whose name
 * contains "test" (e.g. tms_test), so the live Supabase database ("postgres") can never be wiped
 * by mistake. Another name needs ALLOW_DB_RESET=yes set on purpose.
 */
export function assertTestDatabase(url = process.env.DATABASE_URL ?? '') {
  let name = '';
  try { name = decodeURIComponent(new URL(url).pathname.replace(/^\//, '')); } catch {}
  if (/test/i.test(name) || process.env.ALLOW_DB_RESET === 'yes') return;
  throw new Error(`Refusing to run tests: they delete every table, and DATABASE_URL points at database "${name || '?'}". ` +
    'Use a throwaway database whose name contains "test" (e.g. tms_test), or set ALLOW_DB_RESET=yes if you are sure.');
}
/** Rebuild the schema from every migration file, in order — exactly as done in Supabase. */
export async function resetDb() {
  assertTestDatabase();
  await pool().query('drop schema public cascade; create schema public;');
  for (const f of readdirSync('db/migrations').filter((f) => f.endsWith('.sql')).sort())
    await pool().query(readFileSync(`db/migrations/${f}`, 'utf8'));
}

import { q as dbq, one as dbone } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createUser } from '../src/server/team';
const HOME: Record<string, string> = {
  super_admin: 'admin', operations: 'operations', operations_manager: 'operations', transport: 'transport',
  transport_manager: 'transport', finance: 'finance', messenger: 'messengers', messenger_manager: 'messengers',
  documentation_manager: 'documentations', pro_officer: 'documentations',
};
/** Create a ready-to-use user (password already changed) with a role and department. */
export async function mkUser(by: Actor, name: string, roleCode: string, deptCode = HOME[roleCode]): Promise<Actor> {
  const role = (await dbone('select id from roles where code = $1', [roleCode])).id;
  const dept = (await dbone('select id from departments where code = $1', [deptCode])).id;
  const u = await createUser(by, { full_name: name, email: `${name.toLowerCase().replace(/\W/g, '')}@x.ae`, role_id: role, department_id: dept });
  await dbq('update users set must_change_password = false where id = $1', [u.id]);
  return (await loadActor(u.id))!;
}
export const deptId = async (code: string) => (await dbone('select id from departments where code = $1', [code])).id as string;

let reqN = 0;
/** The fields every new transport request must have (migration 008): Job No. + delivery contact. */
export const reqFields = () => ({ job_no: `JN-${process.pid}-${++reqN}`, delivery_contact_person: 'Receiver', delivery_contact_number: '050 111 2233' });
