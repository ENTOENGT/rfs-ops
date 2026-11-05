# RFS Ops — Freight Forwarding + 3PL Operations

Reliance Freight Systems' operations system: freight jobs, customs/PRO, messenger, transport, warehouse
(3PL) and order fulfilment. Operational only — accounting, invoicing and VAT stay in the company's ERP.
Next.js on Netlify, Postgres on Supabase.

**This is a separate system from the live RFS TMS.** It started as a copy of TMS V9 (1 Nov 2026) and has its
own GitHub repository, its own Supabase project and its own Netlify site. Nothing here reads from or writes to
the live TMS. Build plan and checklist: `docs/FREIGHT_3PL_PLAN.md`.

Design, schema, permission matrix, workflow and financial logic: see `docs/ARCHITECTURE.md`.

## Set up (no command line needed)

1. **Database** — create a NEW Supabase project for RFS Ops (never the live TMS one). Open *SQL Editor* and run each file in
   `db/migrations/` once, in number order: `001_schema.sql`, `002_seed.sql`, `003_masters_assignment.sql`, `004_pod_documents.sql`, `005_departments_managers.sql`, `006_messenger_runs.sql`, `007_phone_app.sql`, `008_request_docs_jobno.sql`, `009_pro_clearance.sql`, `010_rental_trucks.sql`, `011_rental_rates.sql`, `012_safety.sql`, `013_jobfiles_quotations.sql`, `014_quote_margin_print.sql`, `015_warehouse.sql`, `016_docs_cases_vendors_erp.sql`, `017_enquiry_flow.sql`, `018_commercials.sql`.
   To see which ones have already run (from 012 on): `select * from schema_migrations order by name;`
2. **Code** — create a NEW private GitHub repo (e.g. `rfs-ops`) and upload this folder through the GitHub website
   (don't upload `node_modules` or `.next`).
3. **Hosting** — in Netlify, a NEW site: *Add new site → Import from GitHub*, pick the repo. Before deploying,
   add two environment variables:
   - `DATABASE_URL` — Supabase → *Connect* → *Transaction pooler* connection string (port 6543), with your DB password filled in.
   - `SESSION_SECRET` — any random text of 32+ characters.
   - `SUPABASE_URL` — Supabase → Project Settings → Data API → Project URL.
   - `SUPABASE_SERVICE_ROLE_KEY` — Supabase → Project Settings → API Keys → the secret / service_role key.
     Server-only; never put it anywhere else. Then use Settings → "Test file storage" in the app.
4. **First sign-in** — `admin@company.local` / `ChangeMe!2026`. You'll be asked to set a new
   password. Then go to *Users* and create accounts for your team.

## For developers

```
npm install
cp .env.example .env.local     # fill in
npm run dev
npm test                       # needs DATABASE_URL pointing at a THROWAWAY database whose name contains "test" (e.g. tms_test) —
                               # tests delete every table first, and refuse to run on any other database name
# local file uploads without Supabase: STORAGE_DRIVER=local (files go to ./.uploads)
```

Rules for adding features:
- Pages call `/api/*` only. Never query the database from a page or the browser.
- New job fields go through the whitelist in `src/server/jobs.ts` (`BASE_SELECT`). Anything
  commercial goes in `job_commercials`/`job_revenue_lines`, never in `transport_requests`.
- New migrations: add the next number (`013_….sql`, …) — never edit a migration that's been run. End each new
  file with `insert into schema_migrations (name) values ('013_….sql') on conflict do nothing;`
