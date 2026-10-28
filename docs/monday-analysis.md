# monday.com analysis for Artema Portal

Research date: 2026-10-28. Method: web searches plus two page fetches. Several official monday.com help pages returned 403 to the fetch tool, so many figures come from search summaries of official pages or from secondary sites. Every number is tagged **[official]**, **[secondary]**, **[community]** or **[unverified]**. Nothing here is invented. Where I found nothing, it says so.

## Summary

- monday.com is popular because it makes a tracker feel like a spreadsheet that colours itself. Colour status columns, per-department views, automations, dashboards and "updates" threads are the real draw. Most of this is cheap to copy in an internal tool.
- Documented caps are not the shop's problem: 10,000 items per board on non-Enterprise plans, and 500 or 1,000 columns [official + community]. Hundreds of doors is far below the item cap. The ~100+ hidden columns are the likely cause of slowness. monday's own staff say the caps exist to keep boards fast [community], and Capterra reviewers cite slow large boards [secondary].
- Cost: paid plans need at least 3 seats [secondary]. Automation quotas are small: 250 actions a month on Standard, 25,000 on Pro [official, via search summary]. Per-seat pricing for ~30 people is the main money argument.
- Shop-floor tools (Fulcrum, ProShop, Odoo, MIE, Cetec) differ from monday in a few ways. They have a station or tablet "my queue" view, barcode or QR scan to start and stop an operation, per-operation time, and instructions or drawings displayed at the station. monday has none of these natively.
- Top recommendations:
  1. Copy status columns with admin-editable labels, and per-department saved views.
  2. Design for speed: server-side filtering, virtualised rows, and a default view with about 10 columns.
  3. Build a kiosk "my department queue" screen with a big Done button.
  4. Print QR codes on work orders that open the door.
  5. Add an activity log, backups and a monday import before cut-over.
- Biggest replacement risks: losing the audit trail and notifications, no phone access off-site, no backups, and a messy migration.

## What monday does well

| Capability | Why shops adopt it | Weight for the production floor |
|---|---|---|
| Colour status columns (editable labels) | Glanceable state and no training needed. Admin-editable dropdowns fit changing processes. | **Critical** |
| Views and tabs, group-by, filter, sort, hide columns | One data set, many role-specific lenses | **Critical** |
| Automations ("recipes") | Status change triggers notify, move or assign. No code. | High |
| Dashboards and charts | Owner overview without a spreadsheet | High |
| Calendar and timeline/Gantt views | Ship-date view | High |
| Updates threads per item | Context stays on the job. Count shows activity. | High |
| Files column | Attach drawings to the item (the shop uses OneDrive links instead) | High |
| Mirror, connect-boards, dependencies | Relations between boards | Low for a door-per-row model |
| Forms | Intake without Excel | Medium. The shop already has Excel order forms. |
| Workload view | Capacity | Medium |
| Mobile app, notifications, guest access | Remote and external people | Medium. Internal-only, but see Risks. |
| Templates and integrations | Fast start | Low |

Evidence: reviewers use monday to replace Excel for production logs and to track production and shipping [community case notes: https://community.monday.com/t/manufacturing-monday-use-discussion/92236, https://www.casestudies.com/company/monday-com/case-study/goebelwood-industries-customer-case-study]. The ranking above is my judgement. It is not from a survey.

## Where monday falls short

### Documented limits

| Area | Figure | Source and confidence |
|---|---|---|
| Items per board | 10,000 on all plans except Enterprise (100,000) | https://support.monday.com/hc/en-us/articles/4404058746642-Item-and-subitem-limits-per-board [official, via search summary; page itself returned 403 to fetch]. Another help article says 10,000 items plus 10,000 subitems on any plan, so the sources conflict. |
| Columns per board | 1,000 (developer docs); older community posts say 500 | https://developer.monday.com/apps/docs/limits [official]; https://community.monday.com/t/would-like-to-be-able-to-have-more-than-500-columns-on-a-single-board/86037 [community] |
| Subitems per item | 100 | developer docs above |
| Labels per dropdown column | 500 | developer docs above |
| Connected items | 10,000 per board, 750 per cell | https://support.monday.com/hc/en-us/articles/360021743500-Linkage-Limitations- [official] |
| Connected boards | Basic 1, Standard 5, Pro 20, Enterprise 60 | search summary of monday help [official, unverified in detail] |
| Files | 500 MB per file | community staff replies [community]. Not confirmed on the current help page. Also "20k files per board" [community, unverified]. |
| Automation actions per month | Standard 250 automation plus 250 integration actions. Pro 25,000 each. Enterprise 250,000 each. No top-ups: "can't pay to have your actions reactivated". | https://support.monday.com/hc/en-us/articles/360002826680 and https://support.monday.com/hc/en-us/articles/360017556179 [official, via search summary]. The Enterprise figure is repeated by one secondary source. |
| Number of automations per board | Not found | [unverified] |
| API daily calls | Free 200, Standard/Basic 1,000, Pro 10,000, Enterprise 25,000 | https://developer.monday.com/api-reference/docs/rate-limits [official, fetched] |
| API per-minute | 1,000 (other), 2,500 (Pro), 5,000 (Enterprise) queries. Items query returns at most 100 items. | same page [official, fetched] |
| API complexity | 5M per query. App tokens 5M/min each for read and write. Personal tokens 10M/min combined. | same page [official, fetched] |
| API concurrency | 40 (other), 100 (Pro), 250 (Enterprise) | same page [official, fetched] |
| Excel export | 10,000 items max. Table views only. Group, sort and colour not exported. Updates go on a separate tab. Subitem updates excluded. Mirror columns may export empty [community]. | https://support.monday.com/hc/en-us/articles/26989749858578-Export-a-board-to-Excel [official, via search summary] |
| Excel import | Community reports a 50-column import cap on forms or imports [community, old] | https://community.monday.com/t/allow-more-than-50-columns-when-importing-an-excel-file-this-would-be-very-helpful-when-creating-a-form-on-monday/41974 |
| Column permissions | Enterprise only | https://support.monday.com/hc/en-us/articles/360011926640 [official] |
| Activity log retention | Up to 1 year on Pro, up to 5 years on Enterprise. Nothing found for lower plans. | Databricks connector FAQ [secondary]. Not on monday's own page. |
| Offline mode | Not found | [unverified] |

### Pricing for ~30 users

- Paid plans have a 3-seat minimum [secondary]. Seats are per user.
- One October 2026 secondary source lists annual-billing prices of Basic $9, Standard $12, Pro $19 per seat per month. A June 2026 ClickUp review lists Standard $14 and Pro $27, so sources disagree [secondary]. Sources: https://automationatlas.io/answers/monday-com-pricing-explained-2026/ and https://clickup.com/learn/topic/task-management/tools/monday/.
- Illustrative arithmetic only, not a quote: 30 seats at $12 to $19 is about $360 to $570 a month before any increase. Check monday.com/pricing.
- Meaningful automation needs Pro. Standard's 250 actions a month would be used up quickly by a shop with a few hundred doors changing status. Column permissions need Enterprise.
- Shop-floor point: a seat per person means shared floor computers either share a login (against the terms and breaks attribution) or cost a seat each. This is a policy question to confirm with monday sales. I did not find a document either way [unverified].

### User complaints

- Capterra: 67% of 187 negative-theme reviews cite speed slowdowns, especially on large boards. One reviewer reports 10 to 20 second loads. https://www.capterra.com/p/147657/monday-com/reviews/ [secondary, small sample].
- G2 reviewers (2020 to 2023) report big boards taking minutes to load, and one team unable to hold about 20,000 rows a month in a board. Old, not manufacturing.
- monday community has threads on slow page load and rendering: https://community.monday.com/t/mondays-slow-page-load-and-similar-rendering-issues/59649
- Pricing is the most common negative theme on Capterra (54% of 828), with key features in higher tiers [secondary].
- Reports from manufacturers: mostly positive use cases. I found **no** manufacturing-specific complaint or Reddit threads, and no clear example of a manufacturer leaving. Reddit and TrustRadius coverage is thin. This is a gap.

### Fit weaknesses specific to Artema (inference, not sourced)

- Files and jobs are separate (OneDrive links in a column).
- 100+ columns on one board.
- Hand-typed "1 of 13".
- No station queue, scanning or time capture.
- Rework would double count if a row is reopened.

## How comparable tools handle shop-floor tracking

Evidence here is thin. The searches returned vendor pages, add-on listings and one old article. Treat these as patterns, not feature comparisons.

| Tool | What it does (as found) | Source |
|---|---|---|
| ShopOS (Glide) | Shared kiosk: operator picks their name, clocks operations on and off, reports units and scrap. No login or barcodes. Closest to Artema's no-login model. | https://www.glideapps.com/store/shop-os |
| Fulcrum | Work orders on a tablet. Operators clock in, see instructions, pick material, chat. Autoschedule from priority, due date, materials and capacity, pushed to the floor. Shared-login behaviour not found. | https://fulcrumpro.com/article/streamline-production-with-work-orders-in-fulcrum |
| Odoo Manufacturing | Shop Floor app: choose a work centre at launch, Start/Pause/Done/Block buttons, per-operation timing, barcode scanning, worksheets per operation. Shop Floor looks like an Enterprise feature [unverified]. | https://cybrosys.com/odoo/odoo-books/v17/manufacturing/work-orders; third-party add-ons at https://apps.odoo.com/apps/modules/17.0/oe_mrp_workorder_core |
| Cetec ERP | Scan employee badge, then the operation barcode printed on the traveler, to start. Scan again to stop. | https://cetecerp.com/blog/using-kiosk-mode-in-cetec-erp-4-0-for-barcode-time-tracking/ |
| CheckMate WIP (older) | Barcode per work order and per location. A scan moves the job. Overdue report. | https://www.automationworld.com/products/control/article/13298874/barcodebased-job-tracking |
| MIE Solutions | Barcode gun or touch kiosk, with two-way floor-to-office messages. | https://miesolutions.madeinthemidlands.com/news/the-real-importance-of-real-time-tracking |
| ProShop | Paperless work orders and time tracking per a user review. QR travelers, station drawings: **not confirmed**. | https://docs.machinemetrics.com/docs/integrations/erp-connectors/proshop-connector |
| Dozuki | Scan a QR at the workstation and the work instruction appears. | https://www.dozuki.com/blog/hidden-waste-the-unseen-inefficiency-in-shop-travelers |
| JobBOSS², MRPeasy | Small-shop ERP with scheduling and shop-floor data collection. | https://www.sourceforge.net/software/product/JobBOSS |

Not researched (no sourced information): Airtable, SmartSuite, Katana, Kanbanize, Teamhood, Planview. Rework tracking that avoids double counting throughput also had no source. The recommendation below is my own design.

Common pattern worth taking: the unit of the floor screen is the operation, not the job. Each operation has a start, a stop and a quantity, and a short instruction line points to an attachment (Sage traveler guide: https://www.cleverence.com/articles/sage-documentation/work-order-traveler-printing-fields-4726/).

## Recommendations

Effort: S = days, M = 1 to 3 weeks, L = a month or more. Priority 1 is highest.

### (a) Copy because it works

| # | Feature | Reasoning | Effort |
|---|---|---|---|
| 1 | Status columns with colour, and admin-only label editing | The core of what staff like. Keep stable label IDs so renaming does not break history. | S |
| 1 | Saved per-department views (filter, sort, group, visible columns) | Replaces the Dashboard, Shipping Calendar and CNC tabs. Ship defaults per department. | M |
| 2 | Per-door comments with count badge | The "updates" habit. Record the department as the author. | S |
| 2 | Ship-date calendar (month and week) | Shipping Calendar tab today. | M |
| 3 | Rule-based automations (below) | Valued but monday caps them. Keep rules few and visible. | M |
| 3 | Dashboard of a few numbers | Owner view. | S |

### (b) Do differently

| # | Decision | Reasoning | Effort |
|---|---|---|---|
| 1 | Performance design. Server-side pagination or virtualised rows, indexed SQLite, only fetch visible columns, no more than ~10 columns by default per view, column groups per department. | Slowness is the top complaint and the main reason for leaving. | M |
| 1 | Files and jobs together: a folder per door, shown in the door panel | monday keeps these apart. | M |
| 1 | Kiosk UX with no logins: a department picker that remembers the department per machine, big touch targets, auto-return to the queue, and a "who did this" prompt only when needed | Fits shared Windows machines and people who dislike computers. | M |
| 2 | Barcode or QR on printed work orders that opens the door. Scan sets "arrived" or "done" for the current department. | Pattern from Cetec and Odoo. A cheap USB scanner works on shared PCs. | M |
| 2 | Project grouping as data: a project record with N doors, so "1 of 13" is generated, not typed | Removes manual error. | S |
| 2 | Rework as a separate event record linked to the door (department, reason, date), not a status reopen | Prevents double counting throughput. My design, not sourced. | M |
| 3 | Audit log of every change (who/department, old and new value, time) | monday's retention depends on plan. Here it is free and permanent. | S |
| 3 | Import from monday export with a mapping screen (columns and labels) | See migration below. | M |
| 4 | Per-operation time capture (start/stop at station) | Offered by shop-floor tools. Only if the owner wants labour costing. | L |

### (c) Skip

| Feature | Reason |
|---|---|
| Mirror, connect-boards, dependency columns | A door-per-row model does not need them. |
| Gantt and workload | Heavy to build. A ship-date calendar plus a per-department load count is enough at 30 people. |
| Forms builder | Excel intake already exists. |
| Guest portals and external sharing | Local-only. Revisit if customers want status. |
| Templates marketplace and integrations catalogue | Not needed. |
| Per-user permissions and logins | Out of scope by design. Admin-only label and column editing is enough. |

### Automations a door shop would want (5 to 8)

1. When CNC Frame = Done and Panel = Done, set door to "Ready for paint prep" and notify the paint department.
2. When paint = Done, notify assembly. When assembly QC passes, notify shipping.
3. Ship date within 3 days and door not Ready: flag red and add it to the owner dashboard.
4. When a status becomes Stuck or Verification Needed: notify the department lead hand and post a comment.
5. When the order form creates doors: assign the first department's queue and create the door folder.
6. Provider parts (skins, panel assembly, rail and stile) marked late or missing: flag every door waiting on them.
7. QC fail: create a rework event and return the door to the earlier department without resetting its throughput count.
8. Door untouched in a department for N days: flag as stale.

Effort: build one small rule engine (trigger, condition, action) once, then rules are data (M). Notifications on shared PCs need an on-screen "new work" badge and optional sound, since nobody is logged in.

### Five numbers a shop owner wants (my suggestion, not sourced)

1. Doors due to ship in the next 7 days, split by Ready or Not Ready.
2. Doors late (ship date passed, not shipped).
3. Work in progress per department (queue size) and the oldest age.
4. Stuck or Verification Needed count.
5. Rework rate (rework events per 100 doors completed).

### Migration path from monday

1. Export the board to Excel from monday (limit 10,000 items; updates arrive on a second tab) [official]. Export a copy before any cut-over and keep the file.
2. Import with a mapping screen: Excel column to portal field, and monday label text to portal status label. Show unmapped values and let an admin map them before saving.
3. Dry-run preview showing counts and errors. Import is repeatable and idempotent by door number.
4. Import updates (comments) as comments tagged "imported from monday".
5. Files: OneDrive links are kept as links on the door. Copying files into door folders is a separate optional step.
6. Run both systems side by side for 1 to 2 weeks. Compare counts per department before switching off monday.

Caveat: grouping, sort, colours and mirror values may not survive the export [official/community]. Decide which of the 100+ columns matter before import. Hidden columns still export if the view includes them. Confirm in a test export.

## Risks

| Risk | What monday gave for free | Mitigation |
|---|---|---|
| Audit trail lost | Activity log per item | Build the audit log first (S). Ship it before cut-over. |
| Notifications | Email, push and in-app | In-app badges and optional sound, plus an email option if wanted. Decide who needs what. |
| Phone and remote access | Mobile app | Local-only means no access off-site. Decide if owners need a VPN or a read-only view. |
| Backups | monday hosts it | Automatic nightly SQLite backup to a second machine and OneDrive, plus a tested restore. A single local server is a single point of failure. |
| Server downtime | Cloud availability | Auto-start, a spare machine, a printed list of today's ship-date doors as a fallback. |
| Guest sharing | Shareable boards and guests | Probably not needed. Check whether customers or providers use it today. |
| Integrations and API | Zapier-style integrations, API | List what is connected today before cut-over. |
| Data lock-in in reverse | Export is capped and lossy | Keep SQLite export (CSV or Excel) available from day one. |
| Concurrency | Real-time collaboration | SQLite is fine at 30 users with write queueing. Test two people editing one door. |
| No logins | Per-user attribution | Department attribution is weaker. Add an optional "initials" prompt for QC sign-off if it matters. |
| Adoption | Familiar tool | Train the lead hands first. Keep the colour and label look similar. Run in parallel. |
| Scope creep | None | The inventory, kanban and SOP ideas should follow only after the door queue is trusted. |

## Sources

Official monday.com
- Item and subitem limits: https://support.monday.com/hc/en-us/articles/4404058746642-Item-and-subitem-limits-per-board (403 to fetch; content from search summary)
- Developer limits: https://developer.monday.com/apps/docs/limits
- API rate limits (fetched): https://developer.monday.com/api-reference/docs/rate-limits
- Automation and integration actions: https://support.monday.com/hc/en-us/articles/360017556179 and https://support.monday.com/hc/en-us/articles/360002826680
- Linkage limits: https://support.monday.com/hc/en-us/articles/360021743500-Linkage-Limitations-
- Export to Excel: https://support.monday.com/hc/en-us/articles/26989749858578-Export-a-board-to-Excel
- Column permissions: https://support.monday.com/hc/en-us/articles/360011926640
- Permissions overview: https://support.monday.com/hc/en-us/articles/360019222479-Permissions-on-monday-com
- Files: https://support.monday.com/hc/en-us/articles/115005339505

Community and reviews
- https://community.monday.com/t/number-of-pulses-per-board/6979
- https://community.monday.com/t/item-limitation-of-10000-per-board-is-too-low-and-should-be-configurable-maybe-against-columns-number-types/28746
- https://community.monday.com/t/would-like-to-be-able-to-have-more-than-500-columns-on-a-single-board/86037
- https://community.monday.com/t/mondays-slow-page-load-and-similar-rendering-issues/59649
- https://community.monday.com/t/manufacturing-monday-use-discussion/92236
- https://www.capterra.com/p/147657/monday-com/reviews/
- https://www.casestudies.com/company/monday-com/case-study/goebelwood-industries-customer-case-study

Pricing (secondary)
- https://automationatlas.io/answers/monday-com-pricing-explained-2026/
- https://clickup.com/learn/topic/task-management/tools/monday/
- https://www.activepieces.com/blog/monday-com-pricing-2026-plans-costs-automation-limits.md

Comparable tools
- https://www.glideapps.com/store/shop-os
- https://fulcrumpro.com/article/streamline-production-with-work-orders-in-fulcrum
- https://cybrosys.com/odoo/odoo-books/v17/manufacturing/work-orders
- https://apps.odoo.com/apps/modules/17.0/oe_mrp_workorder_core
- https://cetecerp.com/blog/using-kiosk-mode-in-cetec-erp-4-0-for-barcode-time-tracking/
- https://www.automationworld.com/products/control/article/13298874/barcodebased-job-tracking
- https://miesolutions.madeinthemidlands.com/news/the-real-importance-of-real-time-tracking
- https://docs.machinemetrics.com/docs/integrations/erp-connectors/proshop-connector
- https://www.dozuki.com/blog/hidden-waste-the-unseen-inefficiency-in-shop-travelers
- https://www.cleverence.com/articles/sage-documentation/work-order-traveler-printing-fields-4726/

## Not verified or not found

- Per-board automation count limit.
- monday offline behaviour.
- Whether monday allows shared logins on shared floor machines.
- Activity-log retention for Free, Basic and Standard plans.
- Reddit and TrustRadius manufacturing complaints.
- Airtable, SmartSuite, Katana, Kanbanize, Teamhood and Planview shop-floor behaviour.
- ProShop QR travelers and station drawings.
- Current exact seat prices (sources disagree).
