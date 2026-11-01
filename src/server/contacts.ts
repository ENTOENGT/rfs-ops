/** Several contacts per customer (operations, accounts, escalation…) — migration 013. */
import { Actor } from './auth';
import { audit, bad, forbidden, notFound, one, q, tx } from './db';
import { phoneProblem } from '../lib/requestRules';

const UUID = /^[0-9a-f-]{36}$/i;
const canView = (a: Actor) => a.has('customers.manage') || a.has('jobs.view') || a.has('jobfiles.view_all') || a.has('jobfiles.view_department') || a.has('quotes.view');

export async function listContacts(actor: Actor, customerId: string) {
  if (!canView(actor)) throw forbidden();
  if (!UUID.test(customerId)) throw notFound('Customer');
  const c = await one('select id, name, service_instructions from customers where id = $1 and deleted_at is null', [customerId]);
  if (!c) throw notFound('Customer');
  const rows = await q(`select id, full_name, role, mobile, email, is_primary, remarks from customer_contacts
    where customer_id = $1 and deleted_at is null order by is_primary desc, full_name`, [customerId]);
  return { customer: c, contacts: rows, can_edit: actor.has('customers.manage') };
}

export async function saveContact(actor: Actor, customerId: string, b: any) {
  if (!actor.has('customers.manage')) throw forbidden();
  if (!UUID.test(customerId)) throw notFound('Customer');
  await tx(async (c) => {
    if (!(await one('select 1 from customers where id = $1 and deleted_at is null', [customerId], c))) throw notFound('Customer');
    if (b.remove) {
      if (!UUID.test(String(b.id ?? ''))) throw bad('Choose the contact');
      const r = await one('update customer_contacts set deleted_at = now() where id = $1 and customer_id = $2 and deleted_at is null returning full_name', [b.id, customerId], c);
      if (!r) throw notFound('Contact');
      await audit(c, actor, { entity_type: 'customer', entity_id: customerId, action: 'Contact removed', old_value: r.full_name });
      return;
    }
    const name = String(b.full_name ?? '').trim();
    if (!name || name.length > 120) throw bad('Enter the contact name');
    const mobile = String(b.mobile ?? '').trim() || null;
    if (mobile) { const p = phoneProblem(mobile); if (p) throw bad(p); }
    const email = String(b.email ?? '').trim() || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('Email address is not valid');
    if (!mobile && !email) throw bad('Enter a mobile number or an email');
    const role = String(b.role ?? '').trim().slice(0, 60) || null;
    const remarks = String(b.remarks ?? '').trim().slice(0, 500) || null;
    const primary = !!b.is_primary;
    if (primary) await c.query('update customer_contacts set is_primary = false where customer_id = $1', [customerId]);
    if (b.id) {
      if (!UUID.test(String(b.id))) throw bad('Choose the contact');
      const r = await one(`update customer_contacts set full_name = $3, role = $4, mobile = $5, email = $6, is_primary = $7, remarks = $8
        where id = $1 and customer_id = $2 and deleted_at is null returning id`, [b.id, customerId, name, role, mobile, email, primary, remarks], c);
      if (!r) throw notFound('Contact');
      await audit(c, actor, { entity_type: 'customer', entity_id: customerId, action: 'Contact changed', new_value: name });
    } else {
      await c.query(`insert into customer_contacts (customer_id, full_name, role, mobile, email, is_primary, remarks) values ($1,$2,$3,$4,$5,$6,$7)`,
        [customerId, name, role, mobile, email, primary, remarks]);
      await audit(c, actor, { entity_type: 'customer', entity_id: customerId, action: 'Contact added', new_value: name });
    }
  });
  return listContacts(actor, customerId);
}
