-- 025 — Organisation hierarchy (part 1 of the User Management release).
-- Adds job titles (designations), a reporting manager on each user with a loop guard, "which role may hand out which role",
-- an action on every permission (for the module × action grid), team rights and a "team" visibility level.
-- Safe to run twice. Only new tables and columns; nothing is deleted or renamed, every existing screen keeps working.

-- ---------- 1. Designations (job titles, separate from access) ------------------------------------------
create table if not exists designations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  level integer not null default 50,            -- for sorting only: smaller = more senior
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create unique index if not exists designations_name_uq on designations (lower(name));
insert into designations (name, level) values
  ('Manager', 20), ('Assistant Manager', 30), ('Team Leader', 40), ('Senior Executive', 50), ('Executive', 60)
  -- no Salesman / Coordinator / Driver titles: the role already says that
on conflict do nothing;

alter table users add column if not exists designation_id uuid references designations(id);
alter table users add column if not exists manager_id uuid references users(id);
create index if not exists users_manager_idx on users (manager_id) where deleted_at is null;

-- ---------- 2. Loop guard: nobody reports to themselves or to anyone below them; at most 12 levels ----------
create or replace function users_manager_guard() returns trigger language plpgsql as $$
declare above integer; below integer;
begin
  if new.manager_id is null then return new; end if;
  if new.manager_id = new.id then raise exception 'A person cannot report to themselves'; end if;
  -- walk up from the new manager: meeting this person means a loop
  with recursive up(id, depth) as (
    select new.manager_id, 1
    union all
    select u.manager_id, up.depth + 1 from users u join up on u.id = up.id
     where u.manager_id is not null and up.depth < 50
  )
  select max(depth) into above from up;
  if exists (with recursive up(id, depth) as (
               select new.manager_id, 1
               union all
               select u.manager_id, up.depth + 1 from users u join up on u.id = up.id
                where u.manager_id is not null and up.depth < 50)
             select 1 from up where id = new.id) then
    raise exception 'This would make a loop: the new manager already reports to this person';
  end if;
  -- how deep the team below this person goes
  with recursive down(id, depth) as (
    select new.id, 0
    union all
    select u.id, down.depth + 1 from users u join down on u.manager_id = down.id
     where u.deleted_at is null and down.depth < 50
  )
  select max(depth) into below from down;
  if above + 1 + below > 12 then raise exception 'The reporting line would be more than 12 levels deep'; end if;
  return new;
end $$;
drop trigger if exists users_manager_guard on users;
create trigger users_manager_guard before insert or update of manager_id on users
  for each row execute function users_manager_guard();

-- ---------- 3. Which role may hand out which role (set by the Super Admin) ------------------------------
create table if not exists role_assignable_roles (
  role_id uuid not null references roles(id) on delete cascade,          -- the giver's role
  assignable_role_id uuid not null references roles(id) on delete cascade, -- a role they may give
  primary key (role_id, assignable_role_id)
);
alter table role_assignable_roles enable row level security;
alter table designations enable row level security;

-- ---------- 4. An action on every permission (the grid's columns); codes are unchanged -------------------
alter table permissions add column if not exists action text;
update permissions set action = case
    when split_part(code, '.', 2) like 'view%' or code like '%.view' or code like '%.buying.view' or code like '%.selling.view'
      or code like '%.profit.view' or code like '%.charges.view' then 'view'
    when split_part(code, '.', 2) in ('create', 'upload', 'requests') or code like '%.orders.create' then 'create'
    when split_part(code, '.', 2) in ('delete', 'cancel') then 'delete'
    when split_part(code, '.', 2) in ('approve', 'salesman_approve', 'verify') then 'approve'
    when split_part(code, '.', 2) = 'export' then 'export'
    when split_part(code, '.', 2) like 'manage%' or split_part(code, '.', 2) in ('configure', 'assign', 'assign_driver',
      'assign_vehicle', 'override_conflicts', 'escalations', 'agent_coordination') then 'manage'
    else 'edit' end
 where action is null;

-- ---------- 5. Team rights and the "team" visibility level -------------------------------------------
insert into permissions (code, module, name, sensitivity, action) values
  ('users.view_team', 'Administration', 'See my team (everyone who reports to me, at any level)', 'general', 'view'),
  ('users.manage_team', 'Administration', 'Manage my team: add, edit, move and disable people below me', 'admin', 'manage'),
  ('jobfiles.view_team', 'Job Files', 'View Job Files of my team', 'general', 'view'),
  ('jobs.view_team', 'Jobs', 'View transport jobs of my team', 'general', 'view'),
  ('runs.view_team', 'Messenger runs', 'View messenger runs of my team', 'general', 'view'),
  ('pro.view_team', 'PRO', 'View PRO tasks of my team', 'general', 'view')
on conflict (code) do nothing;

-- every manager role sees and manages its team, and gets team visibility where it already has department visibility
insert into role_permissions (role_id, permission_code)
  select r.id, p from roles r, unnest(array['users.view_team', 'users.manage_team']) p
   where r.is_manager and r.retired_at is null
on conflict do nothing;
insert into role_permissions (role_id, permission_code)
  select rp.role_id, split_part(rp.permission_code, '.', 1) || '.view_team'
    from role_permissions rp join roles r on r.id = rp.role_id
   where r.is_manager and rp.permission_code in ('jobfiles.view_department', 'jobs.view_department', 'runs.view_department', 'pro.view_department')
on conflict do nothing;

-- every department manager who manages their people may also shape their own department's roles (only perms they hold themselves)
insert into role_permissions (role_id, permission_code)
  select rp.role_id, 'roles.manage_department' from role_permissions rp join roles r on r.id = rp.role_id
   where r.is_manager and r.retired_at is null and rp.permission_code = 'users.manage_department'
on conflict do nothing;

-- managers may hand out the non-manager roles of their own side, as today (the Super Admin can change this list)
insert into role_assignable_roles (role_id, assignable_role_id)
  select m.id, r.id from roles m join roles r on r.side = m.side and not r.is_manager and r.retired_at is null and r.code <> 'super_admin'
   where m.is_manager and m.retired_at is null
on conflict do nothing;

-- ---------- 6. History of manager and designation changes --------------------------------------------
alter table user_assignments drop constraint if exists user_assignments_field_check;
alter table user_assignments add constraint user_assignments_field_check
  check (field in ('coordinator', 'division', 'manager', 'designation', 'role', 'department'));

-- ---------- 7. "My team" = everyone below a person, at any level (used by the team visibility rules) ------
create or replace function user_team(p_user uuid) returns setof uuid language sql stable as $$
  with recursive down(id, depth) as (
    select u.id, 1 from users u where u.manager_id = p_user and u.deleted_at is null
    union all
    select u.id, down.depth + 1 from users u join down on u.manager_id = down.id where u.deleted_at is null and down.depth < 12
  )
  select id from down;
$$;
revoke execute on function user_team(uuid) from public;
revoke execute on function users_manager_guard() from public;
do $$ begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke execute on function user_team(uuid) from anon, authenticated';
  end if;
end $$;

-- ---------- 8. Starting point (only where empty) -----------------------------------------------------
-- managers get the "Manager" title
update users u set designation_id = (select id from designations where lower(name) = 'manager')
  from roles r where r.id = u.role_id and r.is_manager and u.designation_id is null and u.deleted_at is null;
-- everyone else reports to their department's manager, when that department has exactly one
update users u set manager_id = m.mid
  from (select u2.department_id, min(u2.id::text)::uuid as mid
          from users u2 join roles r2 on r2.id = u2.role_id
         where r2.is_manager and u2.is_active and u2.deleted_at is null and u2.department_id is not null
         group by u2.department_id having count(*) = 1) m,
       roles r
 where u.department_id = m.department_id and r.id = u.role_id and not r.is_manager and r.code <> 'super_admin'
   and u.manager_id is null and u.deleted_at is null and u.id <> m.mid;

insert into schema_migrations (name) values ('025_hierarchy.sql') on conflict do nothing;
