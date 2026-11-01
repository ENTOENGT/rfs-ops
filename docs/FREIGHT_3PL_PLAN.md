# Freight Forwarding + 3PL — build plan and checklist

**RFS Ops is a separate system from the live TMS** — its own repository, Supabase project and Netlify site,
started from a copy of TMS V9 on 1 Nov 2026. The live TMS is not changed.

The copied TMS is being extended into one operations system for freight forwarding and 3PL work.
**Operational only, not an ERP:** accounting, invoicing, VAT returns, payables/receivables and
financial statements stay in the company's separate ERP.

Full audit (30 Oct 2026): "RFS TMS — Audit and Roadmap for Freight + 3PL" (Claude doc).

## Rules for every step
- Existing features keep working; every old test must still pass.
- New tables: row-level security on, public access removed, a row in `schema_migrations`.
- Price stays hidden from Transport, Messenger, PRO and driver users (database rule `user_has_perm`).
- Stock only changes through a recorded stock transaction (from Phase 6).
- Nothing is marked done until its tests pass.

## Working assumptions (change any of them at any time)
| # | Question | Assumption used for now |
|---|---|---|
| 1 | Money features already in the TMS (selling price, VAT, profit, Financials) | Kept. Settings switch "Financials page and money reports" (On by default) hides them |
| 2 | Job File per Job No. | One Job File per Job No. across the company; existing clashes listed for you, never merged automatically |
| 3 | Where it lives | New private repo, new Supabase project, new Netlify site; each step delivered as a zip until Claude has write access |
| 4 | Maps | Decide before Phase 5 |
| 5 | Warehouse details | Decide before Phase 6 |
| 6 | ERP | CSV / Excel export with a send-once log (Part C); a direct API link once the ERP and its API are known |
| 7 | Email / WhatsApp | Decide before Phase 9 |
| 8 | Quotation approval | Below a minimum margin (Settings, default 10%) a manager with "approve quotations" must approve |

## Checklist
- [x] Phase 1 — audit and roadmap
- [x] New separate system created from TMS V9 (name: RFS Ops)
- [x] Phase 2, step 1 — safety: migration record, sign-in limit per connection, test guard (migration 012)
- [x] Part A (deploy 1, migration 013) — money-screens switch; new roles (Sales, Customer Service, Freight Ops, Dispatcher, Warehouse Manager/Operator, ERP admin); customer contacts; Job Files with containers, milestones, closure rules; quotations with approval; accepted quotation → Job File; trips/PRO/runs linked by Job No.; Job File register report
- [ ] Still from Phases 2–3: number series settings, branches/warehouse locations, partner types (shipping lines, airlines, agents, brokers), Excel import of customers
- [x] Part C (deploy 3, migration 016) — Job File documents with checklists, versions, approve/reject, waivers, closing rule; customer service cases with SLA and escalation; vendors and vendor requests with performance report; ERP export (CSV/Excel, no duplicates, confirm/reject log)
- [ ] Still from Phase 4: printable document packs, messenger signature, link a messenger run to a PRO activity
- [ ] Phase 5 — multi-stop, partial/failed/returned delivery, fleet maintenance/fuel/incidents, zones and map
- [x] Part B (deploy 2, migrations 014–015) — quotation margin per line (% or amount) and customer copy (print / PDF / Excel, no cost); warehouse core: bins, customer SKUs, GRN, put-away and moves, stock ledger, batch/expiry, FEFO reserve → pick → pack → dispatch, cancel, counts, condition changes, 5 warehouse reports
- [ ] Still from Phase 6: transfers between warehouses, customer returns, barcode scanning screens
- [ ] Phase 7 — customer orders, vendor coordination, customer service cases
- [ ] Phase 8 — ERP export, sync log, retry, duplicate guard
- [ ] Phase 9 — customer portal, email/WhatsApp, new reports, role dashboards
- [ ] Phase 10 — end-to-end tests, speed, security review, backup/restore test, deployment guide
