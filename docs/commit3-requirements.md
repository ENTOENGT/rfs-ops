# Commit 3 of 3 — requirements (user, 26 Nov 2026)

## Point 6 — Granular module-level permissions
Admin assigns access to specific functions instead of a whole module. Example: a user who manages Local Charges only —
view, add, edit, update applicable rates (if permitted) — and gets nothing else.
Modules: Local Charges, Rate Cards, Vendor Management, Customer Management, Enquiries, Vendor Quotations, Customer
Quotations, Operations, Documentation, Email Templates, User Management, Reports, other relevant modules.
Actions: View, Create, Edit, Delete, Approve, Manage. Configurable per user or per role. Enforced in the backend/API,
not only by hiding menus.

## Point 13 — Booking confirmation and vendor availability check
After the customer approves an option and the user confirms it internally:
1. Customer approval: capture the selected option; notify the assigned user ("Customer approved Option 2 – MSC via Singapore").
2. Identify the original vendor/carrier of the selected rate; prepare an availability confirmation email to that vendor
   with the original quotation reference, routing, cargo details and agreed rate — a draft for review.
3. User reviews and sends it to the original vendor.
4. Vendor response — confirms: record it, allow booking, keep the agreed rate and terms. Unavailable (rate or space):
   AI identifies it, prepares a follow-up asking for the next sailing or alternative routing, notifies the user.
5. If unavailable: prepare a polite email to the customer ("Thank you for confirming the quotation. Unfortunately, the
   originally quoted sailing is currently unavailable. We are checking the next available option and will share an
   updated schedule and quotation shortly."). Never change the approved option or book an alternative without the
   customer's confirmation.

## Point 16 — Complete enquiry workflow within the enquiry page
The enquiry page is the central workspace. Progress section, e.g.: Enquiry Created · Vendor Rates · Compare Rates ·
Prepare Quotation · Send Quotation · Customer Approval · Confirm Availability · Create Booking · Operations Handover.
At each stage: current status, next recommended action with one primary button, pending tasks, completed actions,
outstanding clarification. Examples: "Vendor rates received. Ready to compare." [Compare Vendor Rates];
"Customer approved Option 2. Vendor availability confirmation is pending." [Prepare Availability Email];
"Vendor confirmed availability." [Proceed to Booking]. Not crowded; one clear primary next action. Keep the full activity
history and email communication on the same page.

## Point 17 — Fix Local Charges alignment and review the whole CRM UI
Column alignment, table headers/rows, labels and inputs, spacing, buttons and icons, dropdowns, modals, side panels,
cards, tables, responsive behaviour (desktop and tablet). Consistent spacing, aligned labels/inputs, consistent tables,
no needless empty space, not crowded, readable fonts, clear important actions, consistent buttons/colours. Keep the
visual identity.

## Also in commit 3
- Installable desktop app (PWA "Install app").
- Wider live AI status.
