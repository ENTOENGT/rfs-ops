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
| 1 | Money features already in the TMS (selling price, VAT, profit, Financials) | Kept. A Settings switch to hide them will be added; it starts ON, so nothing changes until you turn it off |
| 2 | Job File per Job No. | One Job File per Job No. across the company; existing clashes listed for you, never merged automatically |
| 3 | Where it lives | New private repo, new Supabase project, new Netlify site; each step delivered as a zip until Claude has write access |
| 4 | Maps | Decide before Phase 5 |
| 5 | Warehouse details | Decide before Phase 6 |
| 6 | ERP | Excel export until the ERP and its API are known |
| 7 | Email / WhatsApp | Decide before Phase 9 |
| 8 | Quotation approval | Decide before quotations are built |

## Checklist
- [x] Phase 1 — audit and roadmap
- [x] New separate system created from TMS V9 (name: RFS Ops)
- [x] Phase 2, step 1 — safety: migration record, sign-in limit per connection, test guard (migration 012)
- [ ] Phase 2, step 2 — Settings switch for money screens; new roles; number series; branches and warehouses as locations; approval rules
- [ ] Phase 3 — customer contacts/addresses, partner types, Excel import, Job File, containers, milestones, quotations; link existing trips/PRO/runs by Job No.
- [ ] Phase 4 — shared documents (checklists, approve/reject, expiry, packs); messenger signature + link to PRO activity
- [ ] Phase 5 — multi-stop, partial/failed/returned delivery, fleet maintenance/fuel/incidents, zones and map
- [ ] Phase 6 — warehouse: bins, SKUs, GRN, put-away, stock ledger, batch/expiry, reserve/pick/pack/dispatch, transfers, counts, returns
- [ ] Phase 7 — customer orders, vendor coordination, customer service cases
- [ ] Phase 8 — ERP export, sync log, retry, duplicate guard
- [ ] Phase 9 — customer portal, email/WhatsApp, new reports, role dashboards
- [ ] Phase 10 — end-to-end tests, speed, security review, backup/restore test, deployment guide
