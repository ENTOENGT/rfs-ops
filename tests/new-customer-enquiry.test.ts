/** 20 Nov feedback: on New enquiry the Coordinator (or Salesman) can add a customer not in the list — "New customer" (company)
 *  or "Walk-in customer" (person) — in the same save. Never a duplicate; a failed enquiry leaves no customer behind. */
import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { resetDb, mkUser } from './helpers';
import { one, q } from '../src/server/db';
import { loadActor, Actor } from '../src/server/auth';
import { createWithCustomer } from '../src/server/newenquiry';

let admin: Actor, cora: Actor, sam: Actor;
const base = { division: 'imports', mode: 'sea_fcl', status: 'enquiry', incoterm: 'CIF', port_of_discharge: 'Jebel Ali' };
const count = async (name: string) => Number((await one(`select count(*) n from customers where lower(name) = lower($1)`, [name])).n);

before(async () => {
  await resetDb();
  admin = (await loadActor((await one("select id from users where email='admin@company.local'")).id))!;
  cora = await mkUser(admin, 'Cora Coord', 'coordinator');
  sam = await mkUser(admin, 'Sam Sales', 'sales', undefined, { coordinator_id: cora.id });
});

test('a Coordinator adds a new company on the enquiry; the chosen Salesman owns it; the contact is in To', async () => {
  const r: any = await createWithCustomer(cora, { ...base, salesman_id: sam.id, new_customer: { name: 'Blue Star Trading', contact_person: 'Ravi', contact_number: '+971 50 111 2222', email: 'ravi@bluestar.ae' } });
  assert.equal(r.customer_created, 'Blue Star Trading');
  const f = await one(`select customer_id from job_files where id = $1`, [r.id]);
  assert.equal((await one(`select user_id from customer_salesmen where customer_id = $1 and is_main`, [f.customer_id])).user_id, sam.id);
  assert.deepEqual(await one(`select full_name, email, email_as from customer_contacts where customer_id = $1`, [f.customer_id]), { full_name: 'Ravi', email: 'ravi@bluestar.ae', email_as: 'to' });
  assert.ok(await one(`select 1 from audit_log where action = 'Customer created on New enquiry'`));
});

test('the same company name again: the existing customer is used, not a second one', async () => {
  const r: any = await createWithCustomer(cora, { ...base, salesman_id: sam.id, new_customer: { name: 'blue star trading' } });
  assert.equal(r.customer_created, null);
  assert.equal(await count('Blue Star Trading'), 1);
});

test('walk-in: a person with a mobile; marked as walk-in', async () => {
  await assert.rejects(createWithCustomer(sam, { ...base, new_customer: { walk_in: true, name: 'Ahmed Ali' } }), /mobile/);
  const r: any = await createWithCustomer(sam, { ...base, new_customer: { walk_in: true, name: 'Ahmed Ali', contact_number: '050 999 8888' } });
  const c = await one(`select c.contact_person, c.remarks, s.user_id from customers c join customer_salesmen s on s.customer_id = c.id where c.name = 'Ahmed Ali'`);
  assert.deepEqual([c.contact_person, c.remarks, c.user_id], ['Ahmed Ali', 'Walk-in customer (person, no company)', sam.id]);
  assert.ok(r.id);
  // the same person (same mobile) comes back: used again; another Ahmed Ali with another mobile is stopped
  await createWithCustomer(sam, { ...base, new_customer: { walk_in: true, name: 'Ahmed Ali', contact_number: '+971 50 999 8888' } });
  await assert.rejects(createWithCustomer(sam, { ...base, new_customer: { walk_in: true, name: 'Ahmed Ali', contact_number: '055 123 4567' } }), /already in RFS CRM with another number/);
  assert.equal(await count('Ahmed Ali'), 1);
});

test('no name: asked for it; an enquiry that fails leaves no customer behind', async () => {
  await assert.rejects(createWithCustomer(cora, { ...base, salesman_id: sam.id, new_customer: { name: ' ' } }), /company name/);
  await assert.rejects(createWithCustomer(cora, { ...base, salesman_id: sam.id, mode: 'nonsense', new_customer: { name: 'Ghost LLC' } }));
  assert.equal(await count('Ghost LLC'), 0);
  void q;
});
