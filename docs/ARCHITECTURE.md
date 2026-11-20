# TMS — Architecture & Design

## 1. System architecture

```
 Browser (Operations / Transport / Finance / Admin)
   │  HTTPS, httpOnly session cookie. The browser NEVER talks to the database.
   ▼
 Next.js app on Netlify
   ├─ Pages (React)        — render only what the API returned
   ├─ API routes /api/*    — every request: authenticate → load permissions → service call
   └─ Services (src/server)— all business rules, validation, audit, permission-shaped SQL
   │  Postgres connection (server-side secret only)
   ▼
 Supabase Postgres  — RLS enabled on every table with NO policies, and anon/authenticated
                      roles revoked, so Supabase's public API exposes nothing even if a key leaks.
 Supabase Storage   — (Phase 4) private bucket for POD/documents, served via signed URLs.
```

Why this shape: the brief requires that Transport cannot see the selling price *even in the
network tab*. That rules out a browser-to-Supabase design (the one used for the ENTOEN
dashboard), because any row the browser can read, the user can read. Here every byte a user
receives is assembled by server code that knows their permissions.

## 2. Confidentiality design (selling price)

Enforced in independent layers, so a mistake in one doesn't leak:

| Layer | Mechanism |
|---|---|
| Storage | Selling data lives in separate tables (`job_commercials`, `job_revenue_lines`). Job queries don't touch them unless the caller has `finance.selling.view`. |
| Query | SQL is built per caller; commercial joins/columns are simply absent for Transport. |
| Response | DTOs are built from an explicit field whitelist — nothing is spread from a DB row. |
| Inputs | Revenue/profit filters and sorts return 403 for users who can't see them (otherwise a user could binary-search the price with "revenue > X" filters). |
| Derived values | **VAT amount and customer total are hidden too** (5% VAT reveals the price). **Profit is only shown to users who can see both selling and cost** (profit + cost = selling). |
| Activity/audit | Each audit row has a sensitivity (`general`/`cost`/`commercial`/`admin`) and is filtered per viewer. |
| Notifications | Fixed templates with job number only — never amounts. |
| Documents | Document types flagged `is_commercial` (customer invoice, customer quotation) are hidden without `documents.view_commercial` + selling view. |
| Notes | Notes can be marked "commercial" — hidden from Transport. |
| Reports/exports | (Phase 6) will reuse the same service functions, so they inherit the rules. |

Verified by `tests/security.test.ts` (14 tests on real Postgres) using a distinctive price and
asserting it never appears anywhere in a Transport user's responses.

## 3. Database schema

`db/migrations/001_schema.sql` — every table for all phases is created now so later phases
don't need disruptive migrations.

- **Access**: `users`, `roles`, `permissions`, `role_permissions`, `user_permission_overrides`, `departments`
- **Organisation (future)**: `companies`, `branches` (nullable `branch_id` on users/jobs)
- **Masters**: `customers`, `locations`, `drivers`, `vehicles`, `vehicle_types`, `subcontractors`
- **Configurable lists**: `job_statuses`, `status_transitions`, `pod_statuses`, `expense_types`, `revenue_types`, `document_types`, `settings`
- **The job**: `transport_requests` (one central record) → `transport_assignments` (history; one `is_current`), `job_cost_lines`, `job_commercials`, `job_revenue_lines`, `job_documents`, `job_pod`, `job_notes`
- **Audit & comms**: `audit_log` (append-only, enforced by trigger), `notifications`, `saved_views`

Key decisions:
- Pickup/delivery are **snapshotted** onto the job even when picked from saved locations — editing a location later mustn't rewrite history.
- Money is `numeric(14,2)`; the app computes in integer fils (no float errors).
- `search_text` is a denormalised, trigram-indexed column (job no., BOE, customer, driver, mobile, vehicle, locations, email subject) → fast partial-match search at 100k+ rows.
- `busy_window` + GiST indexes on assignments make double-booking checks fast (Phase 3).
- Soft delete (`deleted_at`) on masters and jobs; cancelled jobs remain with `cancel_reason`.
- Indexes on job_number (unique), boe_number, customer, status, request/required dates, driver/vehicle windows.

## 4. Permission matrix (defaults — editable in Roles & permissions)

| Permission | Super Admin | Operations | Transport | Finance |
|---|:-:|:-:|:-:|:-:|
| View / search jobs | ✓ | ✓ | ✓ | ✓ |
| Create requests, edit before assignment, cancel | ✓ | ✓ | – | – |
| Assign driver / vehicle, update status | ✓ | – | ✓ | – |
| Override double-booking | ✓ | – | – | – |
| Upload POD / documents | ✓ | docs | ✓ | – |
| Verify POD | ✓ | – | – | – |
| View buying cost | ✓ | ✓* | ✓ | ✓ |
| Edit buying cost | ✓ | – | ✓ | – |
| **View selling / revenue / VAT / discount** | ✓ | ✓ | **✗** | ✓ |
| Edit selling price | ✓ | ✓ | ✗ | – |
| View profit & margin | ✓ | ✓ | ✗ | ✓ |
| Commercial documents | ✓ | ✓ | ✗ | ✓ |
| Reports / export | ✓ | ✓ | ✓ (ops + cost only) | ✓ |
| Manage drivers / vehicles | ✓ | – | ✓ | – |
| Manage customers | ✓ | ✓ | – | – |
| Users, roles, settings, audit | ✓ | – | – | – |

\* Your matrix lists Operations' buying-cost access as "Optional", but Operations also sees
profit — and profit + revenue reveals the cost. So it's on by default. If you turn it off for
someone, the system automatically hides profit from them too.

Per-user exceptions ("Always allow" / "Never allow") sit on top of the role. Changing a
user's role or permissions signs them out everywhere immediately.

## 5. Screens

Dashboard · Transport requests (open queue) · Jobs (all) · New request · Job detail (status
lane, overview, route, cargo, assignment, financial panel, activity; POD/documents/notes in
Phase 4) · Drivers · Vehicles · Customers · Locations · Financials · Reports · Documents ·
Notifications (bell) · Users · Roles & permissions · Settings.

## 6. Workflow

```
Operations                    System                          Transport
──────────                    ──────                          ─────────
Create request ─────────────► Draft or Pending Assignment ──► notified "New request JOB-1001"
(+ selling price, optional)   audit: created / price set
                                                              Assign driver + vehicle
                              conflict check (driver/vehicle)
Notified "assigned" ◄──────── Assigned ◄───────────────────── enter cost lines
                              Confirmed → Dispatched → Picked up → In transit
Notified "delivered" ◄─────── Delivered ◄──────────────────── mark delivered
                              if POD required → POD Pending (dashboard: action required)
Notified "POD uploaded" ◄──── POD Received ◄───────────────── upload POD
                              Completed (locked for normal users)
Management: revenue, cost, profit per job / customer / driver / vehicle / month
```
Transitions are table-driven (`status_transitions`) so admins can add statuses.

## 7. Financial logic

```
Total transport cost   = Σ cost lines (base, fuel, toll, parking, loading, waiting, other)   [ex-VAT]
Gross revenue          = Σ selling lines (base, additional, waiting, other)                  [ex-VAT]
Net revenue before VAT = gross revenue − discount       (discount can't exceed gross)
VAT                    = net × VAT rate  (rate snapshotted per job; half-up to the fils)
Customer total         = net + VAT
Gross profit           = net revenue − total cost       (never VAT-inclusive)
Margin %               = gross profit ÷ net revenue × 100   (blank when revenue is 0)
```
Spec example verified in tests: 285 cost, 400 selling → VAT 20, total 420, profit 115, margin 28.75%.

## 8. Assumptions made

1. Hosting on Netlify + Supabase Postgres (same as FleetRoute), built-in user accounts (admin creates users and resets passwords; no self sign-up, no email needed).
2. Operations owns selling price (per the confidentiality addendum), superseding section 7's "Operations / Commercial / Admin".
3. Amounts entered excluding VAT; input VAT on costs is stored separately and never enters profit.
4. Timezone Asia/Dubai for "today" and past-date checks (configurable in settings).
5. Operations users see all jobs by default; remove `jobs.view_all` to restrict someone to their own requests.
6. The job number is JOB-1001 onward (prefix configurable).
7. An assignment with no ETA occupies the driver/vehicle for 4 hours from pickup for conflict checks.

## 9. Edge cases identified

- Price inference via VAT, customer total, profit, filters, sorting, audit entries, notifications, invoice attachments, notes — all closed (section 2).
- Admin mis-grants "view profit" to Transport → still hidden (derived rule, tested).
- Last Super Admin can't be disabled or demoted; users can't disable themselves.
- Duplicate BOE: warn and require explicit confirmation (same BOE can legitimately need 2 trucks).
- Brute-force logins: 5 failures lock the account for 15 minutes.
- Disabled users / changed permissions: existing sessions stop working immediately.
- Closed/cancelled jobs: financial edits need `jobs.edit_completed`.
- Editing a saved location doesn't alter old jobs (snapshots).
- Re-assignment keeps history (old assignment rows kept, `is_current` flips).

## 10. Phase 2–3 rules (masters, assignment, workflow)

**Assignment checks** — run on the server inside a transaction, with a per-driver/per-vehicle lock so two
people assigning at the same moment can't double-book.

| Check | Level |
|---|---|
| Driver/vehicle already on another job whose time window overlaps (cancelled jobs ignored; back-to-back is fine) | Blocking |
| Driver on leave / off duty / inactive; vehicle in maintenance / inactive | Blocking |
| Driver licence or visa, vehicle registration or insurance expired on the pickup date | Blocking |
| Vehicle type differs from the type Operations asked for | Warning |
| Cargo weight or volume above the vehicle's capacity | Warning |
| Pickup on a different day from the required date | Warning |

Blocking issues need the "Override double-booking" permission (Super Admin by default) and the override is
written to the job's activity. Warnings just need a second click ("Assign anyway").
A job with no ETA occupies the driver/vehicle for 4 hours from pickup.

**Status moves** follow the `status_transitions` table. Who can make which move:
cancel → `jobs.cancel` (reason required); submit a draft → `jobs.create`; unassign → assign permission;
put a dispatched job back to Assigned → override permission; everything else → `jobs.update_status`.
Super Admin can force any move (logged as forced). Confirmed/Dispatched/Picked up/In transit/Delivered
need a driver and vehicle. Picked up / Delivered record actual times. Completed and POD Received need the
POD uploaded or marked "not required".

**Editing a request:** before assignment → `jobs.edit` (Operations); once assigned → `jobs.edit_assigned`
(not given by default, Transport is notified of the change); after delivery → `jobs.edit_completed`.

**Masters:** removals are soft (history keeps names). A driver, vehicle or customer on an open job can't be
removed; a vehicle type in use can only be made inactive. Driver/vehicle/customer name changes refresh the
job search index.

**Custom statuses:** added between two existing steps; the direct route stays open and cancel is allowed.

## 11. Phase 4 — POD, documents, notes

**Storage:** private Supabase Storage bucket `tms-documents` (10 MB/file; PDF, JPG, PNG, XLSX, DOCX).
The browser uploads directly to storage using a one-time signed upload link, so large files never pass
through Netlify's function size limits. The server then confirms the upload using a signed, expiring,
per-user "ticket" and checks the file really arrived before recording it. Downloads go through
`/api/documents/:id/download`, which checks permissions on every click and redirects to a 2-minute link.
Photos over 1.5 MB are shrunk in the browser to max 2000px (a 5 MB phone photo becomes ~0.5 MB).

**Confidentiality:** customer invoices and quotations are "commercial" document types — Transport can't
upload, list, download or delete them (the API answers "not found"), and their upload/removal entries in
the activity log are hidden. Notes can be marked commercial; those are hidden and never notified to Transport.

**POD flow:** upload (pod.upload, Transport) → job goes to POD Received, POD status Uploaded, Operations and
verifiers notified → verify or reject with a reason (pod.verify, Operations + Super Admin) → rejected sends
the job back to POD Pending and notifies Transport → Completed needs POD Uploaded/Verified/Not required.
A verified POD can only be removed by a Super Admin. Removing the last POD reverts the POD status.
Documents are soft-deleted: the record and the file stay for the audit trail.

**Reminders:** delivered jobs with no POD after `pod_reminder_hours` (default 24) notify Transport, then
repeat once per period. The check runs during normal app use (at most every 10 minutes) — no scheduler.

## 12. Phase 5 — Financial dashboard

`/financials` — period presets (today … last year, custom) and combinable filters (customer, driver,
vehicle, vehicle type, status, requested by, assigned by, job number, BOE, completed only).
Jobs counted by required date; drafts and cancelled jobs excluded. Totals and every breakdown
(month, status, customer, driver, vehicle, vehicle type) are summed in integer fils.
VAT is shown separately and never enters profit. CSV export of the breakdown table.

Access: revenue/VAT columns only with `finance.selling.view`; cost only with `finance.buying.view`;
profit only with both + `finance.profit.view`. Transport gets a cost-only page, ranked by cost (so
ordering can't hint at revenue). Charts are dependency-free SVG with text alternatives.

## 13. Phase 6 — Reports

`/reports`: Operational, Financial, Driver, Vehicle, Customer and POD-pending reports. Each has period
(except POD pending, which shows everything outstanding), search, filters, sortable columns, paging and
a totals row covering all matching rows (not just the page).

One server function (`src/server/reports.ts`) produces the screen, print, CSV and Excel output, so the
confidentiality rules are identical everywhere: revenue/VAT/profit columns are removed server-side for
users who can't see them, sorting is only allowed on visible columns, and Transport sees cost-only
versions of the financial and group reports. Exports need `reports.export` and are written to the audit
log (who, which report, period, row count). Excel files have a title block, real numeric cells with
number formats, frozen header and filters; CSV is UTF-8 with BOM for Excel and neutralises text that
would run as a formula. Print / PDF uses a print layout (A4 landscape, Reliance header) and the browser's
"Save as PDF". Export limit: 50,000 rows.

## 14. Company structure — departments and managers (migration 005)

Departments belong to a **side**: Administration, Operations, Transport, Messengers, Finance.
Operations departments: E-Com, Sea-Import, Sea-Export, Air-Import, Air-Export, Documentations,
Commercial (+ "Operations (general)" kept for jobs created before the change). The Super Admin can add,
rename and switch off departments in Settings.

Roles: Super Admin · Operations Manager · Transport Manager · Messenger Manager (department admins,
created only by the Super Admin) · shared sub-user roles (Operations Sub-user, Transport Sub-user,
Messenger, Finance User) · roles a manager creates for their own department.

**Who sees which jobs** (`src/server/scope.ts`, used by every job query): `jobs.view_all` → every
department (Super Admin, Transport, Finance); `jobs.view_department` → own department (+ own requests);
otherwise own requests only. Notifications follow the same rule.

**Managers** (`src/server/team.ts`) manage users and roles of their own department only: never
managers, Super Admins or themselves; can't move people between departments; assign only non-manager
roles of their side or their own department; can hand out only permissions they hold, never admin ones.
A manager's edits never remove exceptions set by the Super Admin.

**Selling price**: off for sub-users by default; each operations manager turns it on per person
("Selling price, revenue and profit" choice on the user) or per department role.

**Hard rule in the database** (`user_has_perm`, migration 005): selling price, revenue, profit and
customer documents can never reach anyone in a Transport or Messenger department, whatever their role
or exceptions say — even if the Super Admin ticks it.

## 15. Messenger runs (migration 006)

Document runs (collect / deliver / submit papers — shipping lines, customs, customers), kept separate from
truck jobs in `messenger_runs` (+ `messenger_run_files`, `messenger_run_notes`). Numbers MR-1001 onward.

Flow: Operations requests (department set automatically) → Messenger Manager is notified and assigns a
messenger (list shows how many open runs each already has that day) → messenger marks **Collected** →
**Delivered** with "received by" and a photo of the receipt (stored in the same private file storage as
PODs, under `runs/`). "Could not complete" needs a reason, notifies the requester and managers, and the
manager reassigns. Cancel needs a reason. Requests can be edited only until assigned.

Visibility (`runScope` in `src/server/runs.ts`): `runs.view_all` → every run (Messenger Manager, Super
Admin); `runs.view_department` → own department (Operations); otherwise only runs they requested or are
assigned to (messengers). Transport has no access. Proof files use the same rule.

Permissions: runs.view_all, runs.view_department, runs.create, runs.cancel, runs.assign, runs.update_status.
Defaults — Messenger Manager: view_all, assign, update_status, cancel · Messenger: update_status ·
Operations Manager and Sub-user: view_department, create, cancel.

### File viewer (no forced downloads)

Clicking any file (POD, job document, Documents page, messenger proof) opens it **on the page** in a
viewer (`FileViewer` in `src/components/JobFiles.tsx`): photos as images, PDFs drawn page by page with
pdf.js (bundled, `isEvalSupported: false`) so Android phones also show them, Excel/Word show a message.
Buttons: Previous/Next, Open in new tab, **Download**, Close. The same permission-checked routes serve
both: `/api/documents/{id}/download?view=1` and `/api/run-files/{id}?view=1` redirect to a 2-minute
signed link that opens in the browser; without `view=1` the link saves the file. Customer invoices stay
hidden from Transport for viewing exactly as for downloading. `X-Frame-Options` is `SAMEORIGIN`.

### Phone app for drivers and messengers (migration 007)

- **Driver role** (`driver`, transport side, `app_only`): permission `jobs.view_assigned` — `jobScope` shows only jobs
  whose current assignment is to a driver record linked to this user. A driver can only take the road steps
  (`DRIVER_STEPS`: dispatched, picked_up, in_transit, delivered) and upload the POD. No masters, dashboard,
  documents page, or price data; the lookups call returns almost nothing for app users.
- **App links** (`src/server/applink.ts`, table `app_links`): "Send app link" on the Drivers page (Transport Manager,
  Super Admin) or the Users page (Messenger Manager, Super Admin — anyone who manages that user). One-time link,
  7 days, only a hash stored; a new link switches off older ones (also the "forgot password" fix). The driver's
  login is created on first send and linked via `drivers.user_id`. Message is sent by WhatsApp (wa.me) or copied.
- `/join/{token}`: choose password → signed in → instructions to add to home screen (Android install button,
  iPhone Share → Add to Home Screen). PWA manifest `src/app/manifest.ts`, icons in `public/app-icon-*.png`.
- Sign-in accepts a **mobile number** (last 9 digits match; a number shared by two accounts can't sign in).
  App users stay signed in 60 days; office users 12 hours.
- `Shell` shows app users a phone layout (no sidebar): drivers → `/my-jobs`, messengers → `/runs`; other pages redirect.
- Drivers are told when a job is given to them, changed, or taken away. Removing a driver switches off their login.

### New Transport Request: Job No., delivery contact, trip documents, 30-day deletion (migration 008)

- **Job No.** (`transport_requests.job_no`): typed by Operations, mandatory, kept exactly as typed (trimmed). The old
  automatic number stays as the **Request No.** (`job_number`, prefix now `TR-`). Existing jobs got their old number as Job No.
  Same department + same Job No. is blocked (app check + unique index `tr_job_no_dept_uq`; cancelled jobs free it);
  another department gets a warning (`JOB_NO_OTHER_DEPT`) and may confirm. Shown on lists, job page, dialogs,
  notifications, reports, trip sheet and the driver app. Search/filter by Job No. everywhere.
- **Delivery contact** name + number mandatory on create (`src/lib/requestRules.ts`, used by form and server); any
  phone number with 7–15 digits (UAE or international). Can be changed later, not emptied.
- **Trip documents**: types Invoice (`shipment_invoice`), Packing list, BOE, BL, Gate pass, Other supporting documents
  (`document_types.is_request_doc`, `retention_days = 30`). Several files per heading, PDF/JPG/PNG, 10 MB. Uploaded from
  the request form after the request is saved; can be added/removed until the trip starts (dispatch), then locked.
  Transport sees "🖨 n to print" on the list and job, opens files in the viewer (**Print**), **Print all**, and
  **Print trip sheet + documents** (one print: a no-price trip sheet with Job No., route, delivery contact, driver,
  vehicle, signatures — then every page of every trip document). PODs and other files are not affected.
- **30-day deletion** (`runDocumentCleanup` in `src/server/documents.ts`): `job_documents.expires_at` = upload time +
  30 days (a replacement gets its own 30 days). Each run deletes the real file from storage first, then marks the
  record `purged_at` and writes "… deleted (30-day rule)" to the job history. Failures: `purge_error`,
  `purge_attempts`, retried next run. Runs logged in `document_cleanup_runs`; one at a time (advisory lock).
  **Schedule**: Netlify scheduled function `netlify/functions/document-cleanup.mjs` (`@hourly`) calls
  `POST /api/cron/document-cleanup` with a key derived from SESSION_SECRET. **Backup**: if no run for 2 hours, the
  next normal page load (notifications check) runs it. **Check**: Settings → Document clean-up (runs, failures, Run now).
  Expired files show "expired, deleted after 30 days"; opening one returns 410 with that message. Jobs and reports stay.
- **Messenger Report** (`reports.ts`, key `messenger`): one list of truck jobs (transport_requests + current
  assignment; dispatch time from the job history "Vehicle Dispatched"; "Assigned by (Transport)" = who assigned it,
  or the subcontractor) and messenger runs (messenger_runs; collected time as dispatch; Job No. only when the run is
  linked to a job). Filters: period (request date), type, Job No., Request/Run No., requester, department, assigned by,
  vehicle, driver, messenger, delivery location, status; sorting, counts, Excel/CSV, print. jobScope + runScope apply.
  Not captured today: a separate "transporter company" (only subcontractor, not used in the UI yet).

### PRO & Container Clearance (migration 009)

Separate from Messenger runs (they only carry documents). Run by the **Documentations** department: **Documentation Manager** role (Operations Manager rights +
PRO supervision: assigns, configures, sees all PRO) and **PRO Officer** (Documentations sub-user, phone app, `app_only`).
Permissions: pro.view_all, pro.view_department, pro.create, pro.assign, pro.update, pro.charges.view/edit (cost),
pro.configure (admin). Defaults: Operations Manager create + view department + see charges; Operations sub-user
create + view department; Finance view all + charges; PRO side can never get selling price (user_has_perm).
- Tables: pro_requests (PRO-1001 + typed Job No.; links to the truck job with the same Job No.), pro_containers
  (customs / inspection / release each tracked per container), pro_activities (many per request or container:
  type, authority, reference no., dates, appointment, remarks, outstanding, next action/by/due, own status),
  pro_charges (actual vs estimate, payment, receipt — never posted to accounts), pro_documents (versions:
  replaces_id/replaced_at), pro_history (every change with who/when/remarks/attachment), configurable
  pro_statuses, pro_authorities, pro_activity_types.
- Rules (`src/server/pro.ts`): visibility `proScope`; officers work only their requests/activities; requesters
  edit details, upload, send drafts and cancel before PRO starts. Customs cleared, container released and
  Completed are separate; Completed is refused until every activity is approved/completed/not required and every
  container released/not required. Same Job No. → warning, never blocked. Container numbers validated (ISO 6346
  check digit → warning). Notifications on create/assign/docs required/approval/rejection/payment/customs cleared/
  release/completion. Reminders + escalation (`runProReminders`): deadline warning, overdue escalation to PRO
  supervisors once, appointment reminders — run by the hourly scheduled task and on app use.
- Screens: /pro (clickable dashboard tiles + filters + list; officers get "My PRO work" cards), /pro/new, /pro/[id]
  (clearance, request, documents with replace/versions, charges, history), /pro/containers, /pro/settings.
- Reports: PRO Request Register, Container Clearance, PRO Officer Performance, Authority Pending, Clearance
  Charges (needs pro.charges.view) — same filters/export/print as other reports.
- No Customs/port/authority system is connected; updates are manual with evidence. A future integration would call
  saveActivity / saveContainer.
- Also in this release: storage links are never cached (StorageClient with `cache: 'no-store'` fetch) — fixes
  "InvalidJWT exp claim" when opening/printing files the next day.

### Rental trucks — hired transport (migration 010)
When own vehicles are not available, Transport hires a truck from a rental company **per job**.
- **Rental companies** master (`subcontractors` table, menu *Rental companies*, perm `vehicles.manage`): name (unique), contact person, number, email, TRN, address, active.
- **Hire** (`POST /api/jobs/{id}/rental`, needs `jobs.assign_driver` + `jobs.assign_vehicle`): rental company, plate, truck type, driver name + mobile, planned pickup / ETA, rental cost (excl. VAT), "give the driver the phone app" tick, remarks. An own-fleet plate is refused. Only one hire can wait for approval per job (`jr_one_open`).
- **Approval** (`rentals.approve`, Transport Manager): a sub-user's hire waits (manager gets a notification; Jobs list filter *Needs action → Rental awaiting approval*). A manager's own hire is approved at once. Approve creates/reuses a hired truck and hired driver (tagged with `subcontractor_id`, so they never appear in own Drivers / Vehicles lists or pickers), then assigns them through the normal `assignJob` (conflict checks, notifications, history), sets `transport_assignments.subcontractor_id`, and adds a `rental` cost line "Rental: Company — PLATE". A newer approved hire marks the older one *replaced*. Reject needs a reason; the requester can withdraw.
- **Hired driver app — both ways:** if ticked, after approval the Send-app-link window opens for the hired driver (same one-time 7-day link as own drivers); otherwise Transport updates status and POD.
- **Bill** (`POST /api/rentals/{id}` action `bill`, approvers or `finance.buying.edit`): rental cost, supplier invoice no., paid / unpaid, paid on. Changing the cost updates the job's rental cost line.
- **Standard rental rates** (migration 011, menu *Rental rates*, `rental_rates`, perm `vehicles.manage`; listed only for cost viewers): rental company + truck type + from + to → standard cost. In *Hire rental truck*, choosing company and truck type lists that company's rates and picks the one matching the job's pickup / delivery; the cost fills in and can still be changed (the window shows "Changed from the standard …"). `job_rentals.rate_id` + `standard_cost` keep the rate used; the job and the report show standard vs agreed cost.
- **Rental Truck Report** (`rentals`, needs cost view): filters period, rental company, Job No., payment. Rental cost and bill are shown only to people who see transport cost; selling price/profit never appear (Transport hard rule unchanged).

## 15b. Safety foundations (migration 012) — start of the Freight + 3PL build

- **Migration record** (`schema_migrations`): one row per migration file that has run. 012 records 001–012; every
  later file adds its own row. Check in Supabase: `select * from schema_migrations order by name;`
- **Sign-in limit per connection** (`login_attempts`, `src/server/ratelimit.ts`): 20 wrong passwords (or 20 bad
  app links) from one network address in 15 minutes → that address gets "Too many failed attempts" (429) for the
  rest of the window, even with the right password. Other addresses are unaffected. Only a SHA-256 hash of the
  address is stored; rows older than a day are cleared. The existing 5-tries lock per account stays as it was.
- **Test guard** (`tests/helpers.ts`): the tests delete every table, so they refuse to run unless the database
  name contains "test" (or `ALLOW_DB_RESET=yes` is set on purpose). The live Supabase database is named
  `postgres`, so it can't be wiped by a mistaken `npm test`.

## 15c. Freight + 3PL Part A (migration 013) — Job Files, quotations, new roles, money switch

- **Job File** (`job_files`, `src/server/jobfiles.ts`, screens `/job-files`): one per shipment, identified by the typed
  Job No. — one live Job File per Job No. across the company (`jf_job_no_uq`; a cancelled one frees it). Direction
  (import / export / cross-trade / domestic), mode (sea FCL / LCL, air, road), parties, route, carrier, MBL/HBL or
  MAWB/HAWB, ETD/ETA + actuals, cargo, and which services it needs (clearance, transport, warehouse).
  Containers (`job_file_containers`, ISO 6346 format), a milestone plan made from direction + mode + services
  (`job_file_milestones`, planned + actual; "departed"/"arrived" fill ATD/ATA), history (`job_file_events`). No prices.
- **Linking**: trips and PRO requests with the same Job No. link by database trigger (`link_job_file_by_job_no`), both
  when they are created and when the Job File is created later; messenger runs follow their truck trip.
- **Closing** (`jobfiles.close`): refused while any linked trip / PRO request / messenger run is open (a failed run
  counts as open), and when a needed service has no finished work. Cancel needs a reason and no open linked work;
  it unlinks everything. Reopen needs the close permission.
- **Visibility** (`jfScope`): `jobfiles.view_all` (Transport, Finance, Customer Service, Warehouse, ERP admin) → all;
  `jobfiles.view_department` → own department + own; otherwise own.
- **Quotations** (`quotations`, `quotation_lines`, `src/server/quotations.ts`, screens `/quotations`): lines with charge
  unit (shipment, container, CBM, kg, trip, pallet, carton, day, lump sum), quantity, cost rate, selling rate; totals
  in fils. Draft → submit → approved (margin ≥ Settings minimum, default 10%) or waiting for approval (`quotes.approve`)
  → sent → accepted (creates the Job File with a typed Job No.) / not accepted / cancelled; expired is computed from
  the validity date. Editing an approved quotation sends it back to draft.
  Confidentiality: `quotes.*` are commercial; cost rates need buying view, selling rates selling view, margin profit view;
  someone who can't see a side keeps its values when editing lines. No invoices — billing stays in the ERP.
- **Hard rule extended** (`user_has_perm`): commercial permissions never reach the Transport, Messenger, PRO or
  Warehouse sides, nor any phone-app role (drivers, messengers, PRO officers) — even if ticked by the Super Admin.
- **New roles**: Sales, Customer Service, Freight Operations, Dispatcher, Warehouse Manager, Warehouse Operator,
  ERP Integration Administrator. New side and department: Warehouse.
- **Customer contacts** (`customer_contacts`): several per customer, one main; Customers → Contacts. Customers also get
  "standing instructions for every shipment", shown on each Job File.
- **Money screens switch** (Settings → "Financials page and money reports", default On): Off hides and refuses the
  Financials page and makes every report drop revenue, VAT and profit. Nothing is deleted; turning it on restores it.
- **Report**: Job File register (`jobfiles`), same filters / Excel / CSV / print as the others.

## 15d. Freight + 3PL Part B (migrations 014–015) — quotation margin + customer copy, warehouse core

**Quotations (014):** each charge line can take its selling rate from cost + margin — `percent` (selling = cost ÷ (1 − %),
so the margin is that share of the selling price) or `amount` (cost + amount) — or a typed rate. Only people who see both
cost and selling can set or see the margin; someone with selling view only who types a new rate ends that line's margin.
**Customer copy** (`customerCopy`, `/quotations/[id]/print`, `?format=xlsx`): selling rates, total, VAT note, scope /
exclusions / terms, company details from Settings — never cost or margin, whoever opens it. Only approved, sent or accepted
quotations within validity; every print / download is written to the quotation history.

**Warehouse (015, `src/server/warehouse.ts`, screens `/warehouse`):**
- Warehouses → bins (`warehouse_locations`: receiving / storage / dispatch / quarantine / damaged; added by list or range).
- SKUs belong to one customer (customer-owned stock); optional batch and expiry tracking.
- `stock_balances` (on hand + reserved per bin / SKU / batch / expiry / condition) change only through `post()`, which writes
  the `inventory_transactions` ledger row in the same transaction with the balance row locked. The database refuses negative
  stock and more reserved than on hand; the ledger is append-only (trigger). Tests check ledger = balances after every step.
- GRN: expected → received (good into a chosen bin, damaged into the DAMAGED area; batch / expiry required when tracked;
  differences from expected allowed and reported); optional link to a Job File by Job No.
- Moves / put-away between bins; reserved stock can't move; condition change (damaged / quarantine) needs `warehouse.adjust`
  and a reason. Stock count adjustment: manager only, reason, never below reserved.
- Outbound orders: reserve (FEFO: earliest expiry, then oldest; good and unexpired only; short → refused unless partial) →
  pick (pick list by bin) → pack (packages, weight) → dispatch (stock leaves, ledger written) or cancel (reservations released).
- Permissions: warehouse.view / receive / move / dispatch / adjust / configure / orders.create. Warehouse Manager has all;
  Operator view, receive, move, dispatch; operations roles view + create orders.
- Reports: Stock on hand, Batch and expiry, Inventory ledger, GRN register, Dispatch register.
- Quantities only — valuation and accounting entries stay in the ERP.

## 15e. Freight + 3PL Part C (migration 016) — documents, customer service, vendors, ERP export

- **Job File documents** (`jf_documents`, `src/server/jfdocs.ts`, panel on the Job File): checklist from `doc_requirements`
  (by direction, mode group sea/air/road, and needed service; editable in Settings). Upload (PDF, JPG, PNG, Excel, Word,
  10 MB) with versions; approve / reject with a reason (`documents.approve`, uploader notified); "not needed for this file"
  waivers with a reason; removal is a soft delete recorded in the history. Files open through `/api/jf-files/{id}` with the
  Job File's own visibility. Setting `jobfile_docs_required_to_close` (default on): closing needs every required document
  approved or waived. Job File tile/filter "Documents missing".
- **Customer service cases** (`cs_cases`, `src/server/cases.ts`, `/cases`): customer + optional Job File, type, channel,
  priority, owner. SLA hours per priority (Settings `cs_sla_hours`: urgent 4, high 8, normal 24, low 72); the clock pauses
  while waiting for the customer (due time moves on). Resolve needs a resolution; close only after resolve. Overdue cases
  escalate once to `cases.escalations`. Visibility: `cases.view_all` (Customer Service, Finance) or own department / own.
  Report: Customer service cases (response and resolution hours, SLA missed).
- **Vendors** (`vendors` master, `/vendors`) and **vendor requests** (`vendor_requests`, `src/server/vendorreqs.ts`,
  `/vendor-requests`): requested → quoted → confirmed → in progress → completed (proof note) / disputed / cancelled.
  The vendor price is cost: only buying-cost viewers see or enter it. Report: Vendor performance (on time vs needed-by).
- **ERP export** (`erp_batches`, `erp_items`, `src/server/erp.ts`, `/erp`): finished work — completed trips (selling ex
  VAT + cost), completed PRO requests (charges), received GRNs, dispatched orders, completed vendor requests (cost) —
  as CSV / Excel in one fixed layout with stable references (RFSOPS-…). A record can be in only one live export (unique
  index); the ERP result is typed back (confirm with the ERP reference; reject single lines with a reason → ready again).
  `erp.*` permissions are commercial. No ERP API is assumed; storage billing waits for rate cards.

## 15f. One Job No. from enquiry to closing (migration 017)

- A Job File can start as an **enquiry** (`status = 'enquiry'`, list view "Enquiries (quoting)"). It is not a live
  shipment and cannot be closed until a quotation is accepted (or it is set to Open / cancelled).
- **Rate requests** (`vendor_requests.service = 'rate'`, `rate_valid_until`) on the Job No. One request can go to
  several vendors at once (`vendor_ids`): one row per vendor sharing `rate_group`; "Ask more vendors" (`same_as`) adds
  to the group; the same vendor can't be asked twice. The lowest priced, not cancelled, not expired rate is marked
  "Lowest" (`markLowest`, `rateGroup`). Cost viewers only.
- **Choosing a dearer vendor** is allowed but always flagged: `cheaperRateWarning` gives the message ("X quoted less
  for the same request …") on the vendor request page, when picking the rate in the quotation form (confirm box), on
  the quotation (`rate_warnings`, and a "Dearer vendor rate used" event), and confirming that vendor writes a
  "Chosen although another vendor quoted less" event.
- **Quotation on the Job No.** (`quotations.job_file_id`; `/quotations/new?job_file=ID` fills customer and shipment).
  Vendor rates become cost lines (`quotation_lines.vendor_request_id`, must belong to the same Job File); margin on top.
- **Accept** on a file-linked quotation: the same Job File goes enquiry → open, `quotation_id` set, other open
  quotations on it are cancelled ("Qx was accepted instead"). No new Job No.
- Rate requests are never sent to the ERP (nothing to pay).

## 15g. Email drafts (Part D, no migration)

- An **Email** button (`EmailButton`, `/api/email-draft`, `src/server/emails.ts`) on vendor requests (and each vendor
  row on the Job File), approved quotations, Job Files (shipment update: booking confirmed, departed, arrived, customs
  cleared, delivered, documents needed, general) and customer service cases.
- The system writes recipients (vendor email; customer contacts with the primary ticked, the case contact first),
  subject and text with the Job No., references and shipment details. The user checks it and presses "Open in my
  email" (a `mailto:` link to their own Outlook / Gmail) or "Copy text". Nothing is sent from the server and no email
  account is stored. The quotation PDF is attached by the user.
- A customer quotation email shows selling prices only (never cost or margin), and only for an approved, unexpired
  quotation. Each draft uses the same permission as its screen.
- "Email prepared" is written in that record's history; a case reply also counts as the first response.

## 15h. Commercials Department (Part E, migration 018)

- **Structure**: department "Commercials" with divisions Imports / Exports / Cross Trade (`users.division`). Roles
  Commercials Manager, Salesman (`sales`), Coordinator, Agent Coordinator. A Salesman has a dedicated Coordinator
  (`users.coordinator_id`); one Coordinator serves many Salesmen; every change is kept in `user_assignments` (with reason).
  Sea-Import / Sea-Export / Air-Import / Air-Export are retired (`is_active = false`, history kept).
- **Customers**: `customer_salesmen` (one main owner). A Salesman sees own + unowned customers (the first enquiry
  claims an unowned one); a Coordinator sees their mapped Salesmen's; `customers.view_all` = everyone else.
- **One shipment record, three numbers** (`job_files`): Enquiry Ref (ENQ-YY-NNNNN, at creation), Shipping Ref
  (SR-YY-NNNNN, at customer confirmation), Job No. (typed from the ERP at handover; empty until then, unique).
  `stage` follows the work: enquiry → rates_requested → rates_received → quotation_draft → pending_approval →
  sent_to_customer → customer_confirmed → booking_requested → prealert_awaited → prealert_received →
  prealert_verified → handed_over (or lost / cancelled). `status` stays `enquiry` until handover, then `open` and
  the existing Operations workflow (documents, PRO, messenger, warehouse, transport, closing) continues unchanged.
- **Visibility**: `jobfiles.view_assigned` (Salesman / Coordinator / creator), `jobfiles.view_handed_over`
  (Operations), `jobfiles.view_all` (Commercials Manager, admins). Rate requests: Agent Coordinators see only
  those assigned to them. Selling price / margin still blocked for Transport, Messenger, PRO, Warehouse in the DB.
- **Rates**: source (direct line / airline / overseas agent / Agent Coordinator), charges per freight / origin /
  destination with currency and exchange rate (`vendor_rate_charges`), transit, routing, free days, inclusions,
  exclusions, validity, ETD; revised rates keep the old version (`vendor_rate_versions`).
- **Quotation approval**: a Coordinator's quotation goes to the responsible Salesman (approve / reject / return
  for revision); below the minimum margin a manager must also approve; a loss (selling below cost) is shown in red.
  Versions kept at approval, revision and confirmation (`quotation_versions`); customer responses with evidence
  (`quotation_responses`). Customer confirmation needs evidence (a document or a written note).
- **Booking → pre-alert → handover** (`src/server/commercial.ts`): booking request from the chosen rate, booking
  confirmation, pre-alert (received / correction / verified against the booking, details copied onto the record),
  then "Create the operational job" with the ERP Job No. A Commercials Manager can do it before verification, with a reason.
- **History**: all history tables are append-only (DB trigger); `job_file_events.remarks`.
- **Screens**: grouped role-based menu, Commercials overview, Enquiry register on the standard table
  (`DataTable`: sort, pages, columns, CSV / Excel), quotations list on the same table, role tiles on the dashboard.

## 15i. LCL consolidation (Part F, migration 019)

- **Model**: one consolidation (`consolidations`, ref CON-YY-NNNNN) = one container, one carrier booking, one Master BL.
  Many house shipments (`consolidation_shipments`), each with its own HBL (unique per issuer) and a cargo owner:
  own customer (linked to a Job File), partner agent (a vendor) or another authorised party. A Job File sits in at most one
  live consolidation. Partner-agent cargo stays a house shipment — no customer or Job File is created for it.
- **Receiving**: `lcl_receipts` (append-only) records each arrival. Status per house shipment: expected → partly received →
  received, or "received with differences" (damage/shortage or more than 5% off the declared figures). Every house shipment
  must be verified before "Ready for stuffing"; differences need a note on how they were settled.
- **Status**: open → ready → stuffing → stuffed → sealed → dispatched → departed → arrived → closed (or cancelled, which
  releases the house shipments). Stuffing marks each shipment stuffed or shut out; completion needs the container number.
- **Linked shipments**: departed/arrived fills a Job File's ATD/ATA and milestone only when it has none of its own.
  The Job File page shows an "LCL consolidation" panel for Sea LCL files.
- **Documents**: `consolidation_documents` (booking confirmation, MBL/HBL draft and final, stuffing report, photos…), versioned;
  "HBL final missing" is shown before dispatch. History: `consolidation_events` (append-only).
- **Permissions**: `lcl.view`, `lcl.manage`, `lcl.receive`, `lcl.stuff`; warehouse roles get view/receive/stuff.
- **Screens**: LCL menu group — consolidation register (views incl. container monitoring), create, consolidation page with
  9 tabs, house shipment / HBL register, cargo receiving, stuffing and dispatch, 14 LCL reports with Excel/CSV export.

## 15j. Notifications, templates and email history (Part G1, migration 020)

- **Group notifications** (`src/server/notify.ts`): each important event on a shipment notifies its handling group:
  Salesman, Coordinator, an Agent Coordinator with an open rate request on it, and Commercials Managers of that division
  (or of all divisions). The person who acted is not notified. Duplicates are dropped (same person, shipment, event and
  rate request / quotation within 2 minutes). Events come from stage changes (`setStage`) and from rates, quotations,
  booking, reassignment and saved emails. The `notifications` table is the log; the Notifications page filters by event,
  marks items read, and stores each person's "email me too" choices (`notification_prefs`, used from G3).
- **Enquiry Ref with division:** ENQ-IMP / ENQ-EXP / ENQ-CTR-YY-NNNNN for new enquiries.
- **One subject per shipment:** `threadSubject()` = `[ENQ…]` + `[Job No.]` (or `[SR…]` before handover) + Shipment
  Enquiry / Booking / Update + `job_files.email_topic` (the route, fixed when the enquiry opens).
- **Quotation terms templates** (`quote_term_templates`): Scope, Exclusions, Terms, Additional remarks and Payment
  conditions by division, mode, FCL/LCL or customer. The most specific active template fills a new quotation;
  `terms_template_id` and `terms_edited` are kept on the quotation. Issued quotations keep their own text.
- **Email templates** (`email_templates`): 16 emails with `{{Placeholders}}`. Unknown placeholders are refused when
  saving, and agent emails can't use the customer's name. The subject must keep `{{ThreadSubject}}`. The built-in text
  is used until a template is saved. Missing values are listed when a draft is made.
- **Email history** (`email_messages`): prepared emails (Email button) and saved .eml / .msg files, which are read with
  mailparser and msgreader. Attachments (PDF, images, Office, emails, up to 10 MB) become shipment documents with
  `email_id`. The same Message-ID can't be saved twice. A subject with another shipment's [ENQ] tag asks for
  confirmation first.
- **Reassign:** the Commercials Manager changes the Salesman or Coordinator before handover, with a reason. Old and new
  people are notified.
- **Customer Service retired:** the menu item is gone and `roles.retired_at` is set, so the role can't be given. Users
  who have it are flagged. Old cases show read-only on the shipment.
- **Login page:** "MOVING AHEAD" on the left; a larger sign-in form on the right.

## 15k. Route options, vessel legs and BL drafts (Part G2, migration 022)

- **Route options** (`enquiry_routes`, `src/server/routing.ts`): one Enquiry Ref can hold several options (for example
  Shanghai / Ningbo / Shenzhen → Jebel Ali). Option 1 is created from the shipment's own fields when a second option is
  added, and existing rate requests and quotation lines move onto it. Options can be changed until the customer confirms,
  then they are locked. Removing an option needs a reason and isn't allowed while one of its rate requests is open.
- **Rates per option:** `vendor_requests.route_id` is required for rate requests when there are several options.
  `same_as` and booking requests take their rate's option. The cheapest rate is marked within each option (`markLowest`
  with a key), never across options. Agent emails add "– Option N · POL → POD" to the shipment's subject (D2) and list
  the option's details.
- **Quotation options:** `quotation_lines.route_id`. A line takes its rate's option; with several options every line must
  name one, and a rate can't be used under another option. The detail, customer copy (print and Excel) and email show
  one section per option, each with its own total. Accepting asks which option the customer chose (`chooseRoute`): it is
  copied onto the shipment (`selected_route_id`, POL / POD / origin / destination), the other options are kept, and
  only rates for the chosen option can be booked.
- **Booking details:** confirmation date, POL / POD, containers booked, direct / via, and the confirmation file. The
  expected vessel becomes leg 1.
- **Vessel legs** (`shipment_legs`): Direct = one leg; Via = a leg per vessel, checked for order. Leg 1 and the last ETA
  are copied to the shipment. Status goes Pending → Received → Verified. A change is recorded old → new and notifies
  the group (`vessel_changed`).
- **BL drafts** (`bl_drafts`, `job_files.bl_status`): awaiting → received → under review → sent to customer →
  correction required → correction sent → revised received → revised sent → confirmed by customer (locked). Every
  version is kept with when it was sent, to whom, the customer's reply and the correction notes. After confirmation, an
  amendment needs a Commercials Manager and a reason, and starts a new version. The final BL (number, date, file) is
  recorded separately, and only after confirmation.
- **Handover rule (D3):** for Exports and Cross Trade, the customer must confirm the BL draft before handover. A
  Commercials Manager can override with a reason (`handover_override_reason`, plus a history line).
- **Storage (021):** the file bucket accepts .eml / .msg.

## 15l. UI redesign (no migration)

Only the look and the navigation changed. Every URL, permission check, API and workflow is the same.

- **Frame** (`src/components/Shell.tsx`): navy left rail with the module headers only; clicking a module opens its pages in a second panel (`.subnav`), which can be hidden. The rail can be collapsed to icons (forced at ≤1280px) and becomes a drawer at ≤900px. People on the phone app (drivers, messengers, PRO) keep their phone frame.
- **Menu** (`src/lib/navigation.ts`): one list of modules → pages, each with the permission it needs. `visibleModules` hides what a person can't open; `locate` finds the module and page for the current URL and keeps the module the record was opened from.
- **Header**: breadcrumb, global search (`/api/search`, `src/server/search.ts` — every group uses the same scope as its list page), **+ New** (quick create, by permission), notifications, settings, profile.
- **Dashboard** (`/api/home`, `src/server/home.ts`): role sections (Commercials Manager, Coordinator, Salesman, Agent Coordinator, Warehouse, Operations) with counts of real records, each card opening the matching list; "Needs your attention", enquiries per week, pipeline, recent activity. Read-only.
- **Shipment record**: a header with the numbers and people in one row, a 5-step progress line (Enquiry → Quotation → Booking → Pre-alert → Handover; the exact stage under the current step, all 13 on hover) and a Next step box; then one row of tabs (the rest under More): (Overview, Routing options, Rates & quotation, Emails, Booking, Vessel details, BL documents, Documents, Transport & customs, Milestones, Activity). A tab only shows when its panel applies to the stage and the person; it opens on the tab with the next piece of work. `#tab` in the URL opens a tab directly.
- **Tables** (`DataTable`): record count, Excel/CSV export, column chooser, row action menu (⋯). Quotations list has Search / Customer / Service / Status / date filters; cost and margin stay hidden unless the person may see them.
- **Styles** (`src/app/globals.css`): colour, spacing, radius and shadow tokens at the top (navy primary, teal, gold accent from the logo); old variable names map to the new ones so every page picked up the new look.

## 15m. Enquiry details, currencies, Transport handover, LCL Team (migration 023)

- **Cargo lines** (`job_file_cargo_lines`, `src/lib/cargoRules.ts`): package type, pieces, L × W × H in cm / inch / m, weight per line. Packages, weight, CBM, chargeable weight (air 167 kg/CBM, road 333) and W/M (LCL) are worked out from the lines and written onto the shipment. Required on new LCL / air / road enquiries; optional for FCL. Old lines are kept, marked removed.
- **Incoterm rules** (`src/lib/incotermRules.ts`): the term and the direction decide which of pickup address, handover place, port of loading / discharge, delivery address and cargo value are required. The Incoterm itself is required on new commercial enquiries. Checked on the server at creation and whenever the term or one of its fields changes.
- **Enquiry form**: no carrier, vessel, voyage, booking, BL or dates — they come from booking / vessel / pre-alert. One question for the team: the **division**; the direction follows it and cannot drift (it is in the Enquiry Ref).
- **Currencies** (`src/lib/currency.ts`): AED, USD, EUR, INR, CNY on quotations, agent rates, charge lines and cargo value. Settings hold "1 unit = x AED" (`fx_USD` … `fx_CNY`); an agent rate in another currency is converted into the quotation currency when used. Transport, PRO, messenger and warehouse stay in the company currency.
- **Handover to Transport** (`src/server/handover.ts`): "Request transport" on the shipment opens a request filled in from it; the truck job has a **Shipment** tab with references, route, vessel, containers, addresses, cargo lines and the operational documents (BL / AWB / CMR, DO, packing list, customs declaration, POD) through `/api/jobs/[id]/shipment-docs/[docId]`. Never prices, never the commercial invoice.
- **LCL Team**: department `lcl` and role `lcl_team` with lcl.view / manage / receive / stuff only; its menu is Dashboard, LCL Management and the LCL reports; dashboard section "LCL".

## 15n. Courier / Others, Reports page, commercial reports (migration 024)

- **Modes** Courier and Others (migration 024 widens the check). No vessel / BL steps, no ports; Incoterm optional; courier volumetric 200 kg/CBM (5000 divisor); dimensions optional for Others.
- **Reports page**: reports grouped by area in a list on the left (a single dropdown on tablets), one filter row (Period — today, yesterday, this / last week, this / last month, this / last year, custom — and Search), the rest under "Filters".
- **Commercial reports** (`src/server/commercialReports.ts`; period = date the enquiry was opened; scope = the Enquiries list): Salesman performance and Coordinator performance (enquiries, quoted, confirmed and confirmed %, not confirmed with reasons, volume CBM / tonnes / TEU, days to quote, agent replies, follow-ups, confirmed sales and profit / loss in the company currency), Enquiry tracking (one row per enquiry), Shipments by type (FCL / Air / LCL export and import, Cross Trade, Road Freight, Courier, Others + total). Only for the commercial side and managers who see quotations; money columns follow the selling / profit rights.

## 15o. Organisation hierarchy and roles grid (migration 025)

- **Designations** (`designations`): job titles, separate from access. Super Admin adds, renames, switches off (People → Designations).
- **Reporting line** (`users.manager_id`): trigger `users_manager_guard` refuses self, loops and lines deeper than 12. `user_team(id)` returns everyone below a person. Changes to manager and designation are kept in `user_assignments` (reason required when an existing line changes) and the audit log. Disabling a person moves their reports up to their own manager.
- **Team rights**: `users.view_team`, `users.manage_team` (Team Leader scope: only people below them, inside their department; new people report to them). Every manager role holds both, plus `roles.manage_department`.
- **Team visibility**: `jobfiles.view_team` (also quotations and agent rate requests), `jobs.view_team`, `runs.view_team`, `pro.view_team` — records created by / owned by anyone in the team. Managers get the team level where they already see their department.
- **Roles**: every permission has an `action` (view / create / edit / delete / approve / manage / export). Roles page shows one role as a module × action grid; Compare roles keeps the side-by-side table. New roles may start as a copy (limited to what the creator holds). `role_assignable_roles`: the Super Admin chooses which shared roles each manager role may give; enforced on the server; new shared roles are added to their side's managers automatically.
- **Screens**: People page (list with Reports to / Designation and filters, Organisation chart with "Not placed yet", Designations), My team card on the dashboard.

## 15p. Your workflow — Customer Service, routing, handlers, Cross Trade, Clearance, My performance (migration 026)

- **Customer Service** role brought back (same row) in a new Customer Service department, plus **Customer Service Manager**. `job_files.cs_handler_id` — set automatically when the customer confirms (`assignCsOnConfirm`), changeable by the CS Manager, the job's Coordinator or Salesman (who may keep it), or the current handler; reason needed to change.
- **Default handlers** (`default_handlers`): per team, optionally per customer. Used for Customer Service at confirmation, the Operations team at handover, Documentation at DO received / Clearance jobs. Set by each department manager (own team) or the Super Admin.
- **Handover routes** (`handover_routes`): direction + mode → Operations team (Sea / Air Import / Export, LCL, Cross Trade, general). Sea / Air teams re-activated. `ops_handler_id`, `docs_handler_id`, `do_received_at`, `docs_cleared_at`; "DO received" (Ops → Documentation) and "Cleared" (Documentation → Ops). Documentation Executive role.
- **Visibility**: anyone given a part of the job sees it; Documentation sees jobs once the DO is in; the CS Manager sees confirmed jobs nobody has yet.
- **Cross Trade agents**: `origin_agent_id` / `destination_agent_id` (vendors) or `origin_is_us` / `destination_is_us`. In the Job File register with job type and handlers.
- **Clearance & Delivery** (`job_type`): starts at Documentation (or stays with the Salesman who opens it); handover of such an enquiry goes to Documentation.
- **My performance** (`/performance`, `src/server/performance.ts`): own numbers by period with team-specific measures (Commercials, Customer Service, Operations, Documentation, Transport); weekly or monthly chart; managers open their team's; Excel download; print / save as PDF. Department profit card from the financials engine for people who may see profit.

## 15q. Live status and team chat (migration 027)

- **Status** (`src/server/presence.ts`): the app pings `/api/presence/ping` every minute while open (with "did something since"). Online = active in 10 min; Away = open but quiet; Offline = no ping for 3 min ("last seen"); Busy (with a note) and On leave (return date, note) are set by the person in the profile menu; leave can also be set by their manager and ends after the return date. Dots on People, the organisation chart, the shipment header and Who handles it (with a leave warning).
- **Team chat** (`src/server/chat.ts`, `job_chat_messages`, `job_chat_reads`, `job_chat_edits` append-only): a Team chat tab on every shipment for anyone who can open it. New messages appear within ~8 s (the page asks while open). @mentions only for people who can open the job (bell alert); the handling group hears about new messages (deduped 2 min). Files are attached through the normal upload and saved with the job's documents. "Seen by" ticks. No delete; the writer can correct within 5 minutes and the old words are kept. A message that looks like a price is hidden from anyone who may not see selling prices. "Team chats" inbox (`/chats`) and a chat icon with the unread count.

## 15r. Checklists the AI agent follows (migration 028)

- **Enquiry checklist** (`enquiry_checks`, `job_files.enquiry_details`, `src/lib/enquiryGaps.ts`): your own items (label, how to ask, answer type, divisions, modes, on / off) on top of the built-in rules (Incoterm and its addresses, cargo lines or FCL weight, commodity). Additional details section on the enquiry form; a Missing details box above the tabs with **Ask the customer by email** (`enquiry_missing` draft on the enquiry's own subject) and **Fill in**.
- **Agent quote checklist** (`quote_checks`, `vendor_requests.quote_details`, `src/lib/quoteGaps.ts`): items read from the rate request's own fields (freight rate, currency, validity, transit, routing, carrier, ETD, free days, origin / destination charge lines) or extra questions answered on the request; by mode. Once the agent has replied, the request shows what is missing with **Ask the agent by email** (`vendor_missing` draft: the missing items plus the shipment details, never the customer's name or our prices).
- Kept on **Commercials → Checklists** by the Super Admin and Commercials Managers; every change is audited. The AI assistant (G3) will use the same lists.

## 16. Phase status

| Phase | Status |
|---|---|
| 1 Foundation — auth, users, roles, permissions, full DB | Done |
| 2 Masters — drivers, vehicles, customers, locations, vehicle types, settings, statuses | Done |
| 3 Workflow — availability, assignment with conflict checks, status updates, edit/cancel, notifications | Done |
| 4 POD upload/verify/reject, job documents, Documents page, notes, POD reminders | Done |
| 5 Financial dashboard — KPIs, monthly chart, rankings, breakdown tables, CSV | Done |
| 6 Reports — 7 reports incl. department, Excel/CSV export, print/PDF, export audit | Done |
| Structure stage 1 — departments, managers, department-only visibility | Done |
| Structure stage 2 — messenger runs (request, assign, collected, delivered with photo) | Done |
| File viewer — files open on the page, Download is optional | Done |
| Request update — Job No., delivery contact, trip documents + 30-day deletion, Messenger Report | Done |
| PRO & Container Clearance module + file-link fix | Done |
| Structure stage 3 — phone app (from a link) for drivers and messengers | Done |
| Freight + 3PL — Phase 2, step 1: safety foundations (migration record, sign-in limit, test guard) | Done |
| Freight + 3PL — Part A: Job Files, quotations, new roles, contacts, money switch (migration 013) | Done |
| Freight + 3PL — Part B: quotation margin + customer copy, warehouse core (migrations 014–015) | Done |
| Freight + 3PL — Part C: documents + checklists, customer service, vendors, ERP export (migration 016) | Done |
| Enquiry flow — one Job No. from enquiry; rate requests to several vendors with lowest-price warning (migration 017) | Done |
| Part D — Email button with ready-written drafts (vendors, quotations, shipment updates, case replies) | Done |
| Part E — Commercials Department: divisions, Salesman ↔ Coordinator, three numbers, rates, approvals, booking, pre-alert, handover (migration 018) | Done |
| Part F — LCL consolidation: containers, house shipments/HBLs, cargo receiving, stuffing, dispatch, LCL registers and reports (migration 019) | Done |
| Part G1 — group notifications, quotation terms and email templates, one subject per shipment, email history, Customer Service retired, login page (migration 020) | Done |
| Part G2 — route options per enquiry, rates and quotation per option, booking details, vessel legs, BL draft cycle, final BL (migrations 021, 022) | Done |
| UI redesign — module rail + page panel, global search, quick create, role dashboards, tabbed shipment record, modern tables (no migration) | Done |
| Enquiry details — cargo lines, Incoterm rules, shorter enquiry form, division only, currencies, Transport handover, LCL Team (migration 023) | Done |
| Courier / Others modes, Reports page regrouped, Salesman / Coordinator / Enquiry / Shipment-type reports (migration 024) | Done |
| Organisation hierarchy — designations, reporting lines, team rights and visibility, People page, roles grid (migration 025) | Done |
| Your workflow — Customer Service, default handlers, handover routing, Ops ↔ Documentation, Cross Trade agents, Clearance & Delivery, My performance (migration 026) | Done |
| Live status and team chat on each shipment (migration 027) | Done |
| Enquiry and agent quote checklists, missing-details emails (migration 028) | Done |
| Freight + 3PL — remaining phases: see `docs/FREIGHT_3PL_PLAN.md` | Planned |
| 7 Email notifications · 8 Saved views, column prefs, live ops table, performance | Planned |

### 15s. Documents are kept for good (migration 029, 19 Nov 2026)
The 30-day document clean-up is switched off. Migration 029 empties `document_types.retention_days` and the `expires_at`
of every file not yet deleted. `runDocumentCleanup` returns without deleting (DOCUMENTS_KEPT_FOR_GOOD), the Netlify scheduled
function has no schedule, and a file counts as "expired" only if it was really deleted earlier (`purged_at`). Files the old
rule already deleted cannot be brought back; their records and history stay. Settings → Documents shows the old history.

### 15t. RFS CRM name, sending from Outlook, invitation email (19 Nov 2026)
- The app is called **RFS CRM** on screen (title, phone-app name, texts). The web address stays rfsops.netlify.app.
- Outlook step 2: the Email box shows **Send from my Outlook** for a pilot user whose Outlook is connected (`emailSend` →
  `outlook.sendMail`, Graph `/me/sendMail`, saved in their Sent Items). It is noted as *sent* (email_messages.status 'sent')
  in the same histories as a prepared email. Others keep "Open in my email" / "Copy text".
- Invitation: after **Add person** (office staff) and from **Send invitation** on People, `inviteUser` makes a one-time
  join link (app_links, 48 hours, older links switched off) and emails it from the sender's Outlook, or returns the email
  to copy / open when Outlook is not connected. No password is ever put in the email; the temporary password stays as a backup.
  The /join page has an office version that signs the person straight into RFS CRM. No database change.

### 15u. Outlook step 3 — reading the inbox (migration 030, 19 Nov 2026)
`src/server/inbox.ts`. For a connected pilot user, `syncInbox` reads the Outlook inbox with Microsoft Graph delta
(`/me/mailFolders/inbox/messages/delta`, first time `receivedDateTime ge` 7 days ago, 50 per page, at most 10 pages per check;
the next/delta link is saved in outlook_connections.delta_link so each check only reads what is new). Read only.
Matching: a [TAG] in the subject that is an Enquiry Ref, Job No. or Shipping Ref → else the same conversationId as an email
already filed. Matched → email_messages (direction in, status received, source mailbox, web_link), a history line and a
group notification ('email_saved'). Not matched but from a known customer / contact / agent (exact address or same company
domain, public mail domains excluded) → outlook_inbox status 'unmatched' ("Emails to file" on My Outlook: file by reference —
the rest of the conversation follows — or "Not for a shipment"). Unknown senders are not saved. Every email is noted once per
person (unique user_id + ms_message_id). Checks run from "Check inbox now", on opening My Outlook, and every minute while
the app is open (no scheduled function). An expired delta link is cleared, so the next check starts again from 7 days back.
Fix (031): "one check at a time" is outlook_connections.sync_started_at (cleared after the check, ignored after 2 minutes),
not a session advisory lock — the Supabase transaction pooler left that lock held, so every later check returned busy.
A check stops fetching new pages after ~6 s (25 emails a page) and the next check carries on from the saved link.

### 15v. AI agent part A — customer replies → missing details (migration 032, 19 Nov 2026)
`src/server/ai.ts` calls the Anthropic Messages API (ANTHROPIC_API_KEY; AI_MODEL optional, default `claude-haiku-5-5`), always with
one forced tool so the answer has a fixed shape; 8-second limit. `src/server/agent.ts`: `readEmail` takes a received email on an
enquiry, fetches its full text once from the Outlook it came into (kept in email_messages.body_text), sends Claude the enquiry's
missing details (`enquiry_gaps`: built-in + checklist, with key, label, format and what we asked) and the email, and checks the
answer (only listed keys; yes/no, YYYY-MM-DD, numbers, Incoterm codes; NA → "not answered clearly"). Saved as ai_suggestions
(one per email; 'open' or 'nothing'). The enquiry page (AiSuggestions) reads the newest unread received email by itself when the
enquiry still has gaps and the viewer can edit it. Nothing changes until a person ticks answers and presses "Fill in" →
`updateJobFile` in their name + a history line; or Dismiss. Cargo lines are shown but filled by hand.

### 15w. To / CC follow the shipment (migration 033, 19 Nov 2026)
`src/server/emailpeople.ts`, used by every customer email (job file, missing details, quotation, case). To / CC are built from:
the shipment's people (job_file_email_people: seen on the customer's own emails — sender in To, the people they copied in CC —
or typed in by our team), the customer's contacts (customer_contacts.email_as To / CC / none; empty = main contact in To),
our side in CC (salesman, coordinator, CS handler of the shipment; the sender never copies themselves) and the Settings
"Always CC on emails to customers" (customer_email_cc). × (POST /api/job-files/:id/email-people) marks a person removed for
that shipment only; nothing brings them back except someone typing them in again. Agents' emails never add people.
The email box has To and CC rows; CC goes with Send from my Outlook, the mailto link and the history (email_messages.cc_addrs).
Also: an email already on a shipment is never noted twice in its history.

### 15x. Ports, regions and agent coverage (migration 034, 19 Nov 2026)
- `src/data/ports.json`: UN/LOCODE seaports (function 1) and airports (function 4), about 24,800 places in 249 countries, with a
  rough size `weight` (number of transport functions, +1 when approved). `ensurePortsLoaded` copies it into `ports` / `countries`
  the first time anyone searches (safe to repeat; your own ports and changes stay). Letters that look like secret keys
  ("sk-" in Russian place names) are written as \u escapes so the Netlify secret scan does not stop the build.
- Port search (`/api/ports`): code / airport code, then the chosen country, then name match, then size. Your own ports
  (inland depots / ICDs) get codes like AEX00. Regions are your own groups of countries (Commercials → Ports & regions).
- Enquiries keep the port names as text and also `pol_code` / `pod_code` and `origin_country` / `destination_country`
  ("collection anywhere in Germany" = a country without a port). The port boxes suggest from the list as you type.
- `agent_coverage` (Vendors → Coverage): a port, a country or a region; modes; origin / destination / both; priority.
  `suggestAgents` lists, for each end outside the UAE, every active agent covering it: that port first, then any port in the
  same country and the country itself, then regions — preferred before normal before backup. "Ask agents for a rate" ticks
  them all (up to 40 at once); "Email all from my Outlook" sends one separate email per agent that has not answered yet.
- The old `vendor_regions` table (migration 018) was never used by any screen; it is left as it is.

### 15y. Bulk upload of customers and vendors (20 Nov 2026)
`src/server/bulkimport.ts`, Administration → Bulk upload. The Excel template (`GET /api/bulk-upload/template`) has four sheets —
Customers (with main salesman / other salesmen by email), Customer contacts (main contact, On emails To / CC / Not by default),
Vendors (type from the list) and Vendor coverage (Port code / Country / Region, modes, side, priority) — plus "Read me" and
"Lists" (salesmen, choices) for drop-downs. `POST /api/bulk-upload` with `import: false` checks the file and returns, row by row,
new / already there / problem (nothing saved); with `import: true` the good rows are saved in one transaction (multi-row inserts)
and one audit line. Never a duplicate: customers match by name or code and vendors by name — only their empty fields are filled;
a contact whose email is already on the customer is skipped; existing coverage is skipped; the main salesman is set only when the
customer has none. Fields use the same checks as the Customers / Vendors forms. Salesmen may upload only their own customers;
giving customers to other salesmen is for the Commercials Manager. Up to 1,000 rows per sheet, 5 MB.

### 15z. AI finds new enquiries in the inbox (migration 035, 20 Nov 2026)
`src/server/newenquiry.ts`. Enquiries arrive in the Salesman's and the Coordinator's own mailbox (both Outlook pilots).
- Reading the inbox (`inbox.ts`): an email that matches no shipment is kept as before when the sender is a known customer /
  agent; from an unknown sender it is now kept as `screen` (hidden) for the AI — never automatic mail (no-reply, news…) or our
  own colleagues, and only when the AI key is set. An email whose internet message id was already made into an enquiry from
  another inbox is filed on that enquiry ("same email").
- `screenInbox` (after every check; `/api/outlook/screen`): Claude Haiku looks at sender, subject and first lines →
  new_enquiry / reply / other. The same email in two inboxes is looked at once. An unknown sender's email that is not an
  enquiry becomes `ignored` with its subject, text and names wiped. New enquiries show first on My Outlook → Emails to file.
- `draftEnquiry` ("Create enquiry", read once and kept in outlook_inbox.ai_draft): the full email from Outlook → customer
  (existing by sender email / company domain, else a new customer from the signature), Salesman (the customer's main one, else
  the Salesman whose inbox it is / who was written to), mode, Incoterm, countries and ports from the port list, direction /
  division from where the UAE is, addresses, cargo, weight, ready date and DG (checklist answers).
- `createFromEmail`: one transaction — the new customer (never twice: same name is reused) with the sender as main contact (To)
  and the Salesman as main owner, `createJobFile`, the email filed on it, and every inbox copy of the same email marked filed.
  Nothing is created until a person presses Save on the New enquiry page (`/job-files/new?from_email=…`).

### 15z+. Fixes after the first live test (20 Nov 2026)
- Our own domains (`ourDomains`): a connected Outlook mailbox's domain, the company email, or a domain shared by 2+ users.
  `knownSender` never takes our own address as a customer; automatic senders are dropped before anything else; waiting rows
  that are ours / automatic are wiped at the next check (`tidyWaiting`). AI "other" emails from customers are hidden behind a
  "show them" link. The quick look is told that "please quote the attached sheet" is a new enquiry and whether there are attachments.
- `src/server/attachments.ts`: "Create enquiry" also reads up to 3 attachments (3 MB each): .xlsx / .xlsm / .csv / .txt / .docx
  as text (10,000 characters), PDF and pictures as Claude content blocks; .xls and others are named in a note. A draft kept from
  before attachments were read is read again once. The draft call gets 9 seconds.
- No dark-mode colours: the app is always light.
