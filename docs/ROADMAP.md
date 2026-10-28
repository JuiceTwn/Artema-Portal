# Artema Portal: feature ideas and roadmap

Ideas for making the Portal an all-in-one internal tool for a manufacturing business, in the way monday.com is for tracking, plus the shop's files, quality, materials and planning. Nothing here is built yet unless it says so. The monday.com research behind it is in [monday-analysis.md](monday-analysis.md); that report is thinner than hoped (several official pages blocked the fetch), so figures in it are tagged by confidence. Items marked **(mine)** are our own suggestions, not sourced.

Effort: **S** = days, **M** = 1 to 3 weeks, **L** = a month or more.

## Built so far

Editable status, date and text columns with admin-editable coloured labels; tabs (views) that choose the columns; per-door comments and notes; archive; New door; dense Board with Compact / Standard / Large rows; Customize screen (admins only); order-form intake; backups; optional guided steps (off by default). See [PLAN.md](PLAN.md).

Since then: **Station** (a big-button floor queue per tab, one-tap Done, two-tap Stuck), **tab filters** (a tab shows a door once the steps before it are finished, so a door turns up on the next station by itself, including steps that wait for several others), **automations** (rules: when / if / then, run in the same transaction, one Undo for a change and what it set off), and a **door shop starter** that sets up the Artema flow (cutting, three CNC tracks, frame filling, rail & stile filling and assembly, verification, paint prep, paint, assembly, wrapping and QC, shipping). Not built yet from the automations plan: rules that fire on time (ship date near, door stale) and send-back-for-rework.

## Principles

- **A template, not a door app.** Columns, labels and tabs are already data an admin edits. To work for any manufacturer, the rest should become data too: the department list, what the order-form reader looks for, and the stations a door moves through.
- **Easy before clever.** Every screen should have one obvious thing to do. People who dislike computers must not get lost.
- **No logins.** Actions are recorded by department, with an optional name on a sign-off.
- **The door is the centre.** Files, comments, status, parts and quality all hang off the door.

## Automations: the door moves itself

Instead of notifying someone, an automation **moves the door to the next station**. A door turning up in the next station's tab is the notification, so nothing needs a login, an email or a sound.

**Stations.** A *station* is where a door is right now: one status column (call it "Station") with an admin-editable list such as Frame Prep, Paint, Assembly, Shipping, Done. The department tabs can show "doors at this station", so moving a door changes whose list it is on. Providers (skins, panel assembly, rail & stile) and bought parts stay as their own status columns that a station waits on.

**A rule** is data an admin edits: *when* something changes, *if* conditions hold, *then* do actions. It runs on the server right after a cell changes, in the same transaction, so a change and its follow-ups happen together or not at all.

Actions a rule can take:
- **Move to the next station**, or to a named station.
- **Send back to a station** for rework. This is recorded as a rework event on the door and does not count the door twice in throughput.
- **Set a cell**, for example set "Priority" to Rush.
- **Add a comment** ("Moved to Paint automatically").
- **Archive** the door.

Starting rules a door shop would want (all editable):

| # | When | Then |
|---|---|---|
| 1 | Station is Frame Prep, CNC Frame is Done and CNC Panel is Done | Move to the next station (Paint) |
| 2 | Station is Paint and Paint status is Done | Move to the next station (Assembly) |
| 3 | Station is Assembly and Assembly QC is Passed | Move to the next station (Shipping) |
| 4 | Station is Shipping and status is Shipped | Archive after N days |
| 5 | Door added from an order form | Put it at the first station, create its folder |
| 6 | Ship date within 3 days and the door is not Ready | Set Priority to Rush (a flag, not a message) |
| 7 | A status becomes Stuck or Verification Needed | Add a comment, flag "Needs a look" |
| 8 | A QC label is Failed | Send back to the station named on the label (rework event, no double count) |
| 9 | Door not changed for N days at a station | Flag as stale |

Design notes (mine):
- Guard against loops: a rule runs at most once per change, and chains stop after a few steps.
- Every automatic move is in the history as "automation: <rule name>", and has an Undo like any other change.
- Rules can be switched off one by one; a preview shows which doors a rule would move before it is saved.
- No monthly quota. monday.com limits actions (250 a month on Standard, 25,000 on Pro, per its help pages, via search summary) and does not let you buy more; here rules are unlimited.
- Effort: **M** for the rule engine (trigger, conditions, actions) and a simple rule editor; the rules themselves are data.

## Feature ideas

### Quick wins

| Idea | Why | Effort |
|---|---|---|
| Audit log screen: who (department), what, old and new value, when | We already record every change; it needs a page. Replaces monday's activity log, which is only kept 1 to 5 years depending on plan. | S |
| Ship-date calendar (month and week) | Replaces the Shipping Calendar tab | M |
| Owner dashboard, five numbers: doors shipping in 7 days (ready or not); late doors; work per station with the oldest age; stuck count; rework rate | The overview an owner asks for (mine) | S |
| Bulk edit: tick rows, set a status for all | Saves clicks at shift change | S |
| Project record so "1 of 13" is generated | Already derived from the order form; add editing and a project page | S |
| Saved filters per tab and "group by" a status column | monday's group, filter and sort | S |
| "New" marker on a door that just arrived at your station | Replaces notifications on shared computers | S |

### On the floor

| Idea | Why | Effort |
|---|---|---|
| QR code on each printed work order that opens the door; a USB scanner marks "arrived" or "done" for the department | Pattern seen in Cetec, Odoo and others; works on shared PCs | M |
| Station kiosk: a department's list full screen, big buttons, no login | Fits people who dislike computers | M |
| Photos on a door (defects, QC) from a phone or webcam | Evidence for rework and customers | M |
| SOPs and drawings shown at the station, linked to the department and door type | Original goal in the README; Dozuki-style pattern | M |
| Optional start/stop time per operation | Only if labour costing is wanted | L |

### Materials and purchasing

| Idea | Why | Effort |
|---|---|---|
| Bought parts as records: supplier, due date, arrived | Replaces notes like "waiting for glass"; the board can show what is late from a supplier | M |
| Parts list per door, read from the order form | Needed for purchasing and inventory (mine) | M |
| Inventory kanban cards with reorder points | The "dream" in the README; builds on the parts list | L |

### Quality

| Idea | Why | Effort |
|---|---|---|
| QC checklists per station, signed by the lead hand | Today's QC is a status label | M |
| Defect log with reason and photo; rework reports by station | Finds the stage causing the most rework (mine) | M |

### Planning

| Idea | Why | Effort |
|---|---|---|
| Capacity view: doors per station against ship dates | Enough for 30 people; skip a full Gantt (mine) | M |
| Lead times learned from history (average days per station) | Realistic ship-date promises (mine) | M |

### Files

| Idea | Why | Effort |
|---|---|---|
| Folder per door with versions, restore, previews | monday keeps files apart from the job; here they are together | M |
| "Sent to CNC" record when a program is released | Closes the loop with the machines | S |

### Moving off monday safely

| Idea | Why | Effort |
|---|---|---|
| Import from a monday Excel export with a mapping screen (columns and labels) and a dry run | Loads real doors, labels and colours without retyping. monday's export is capped at 10,000 items and is lossy (group, sort and colours are not exported) | M |
| Parallel run for one to two weeks, comparing counts per station | Safe cut-over | process |
| Backups to a second machine and a tested restore; export to Excel from day one | A single local server is a single point of failure | S |

### Make it reusable by other manufacturers

| Idea | Why | Effort |
|---|---|---|
| Departments and stations editable by admins | Today the list is fixed in code | M |
| Order-form profiles: which labels the reader looks for | Today it is the door order form only | M |
| Starter templates (columns, labels, rules) per kind of shop | A new business starts from something that looks like theirs | M |

## Suggested order

1. Stations and the rule engine (move to next station), with the audit log screen.
2. Calendar and owner dashboard.
3. Monday import and the parallel run.
4. QR on work orders and the station kiosk.
5. Bought parts and the parts list, then inventory.
6. QC checklists and the defect log.
7. Editable departments and order-form profiles.

## Open questions

- What are the stations, in order, and which ones can a door skip?
- Does "moving to the next station" also clear the previous station's status columns, or keep them as history?
- Which labels count as finished at each station?
- What do the timeline pill colours mean on the monday board? (Currently coloured by urgency.)
- Is there anything on the monday board that is a formula, mirror or automation we have not seen?
- Does anything outside the shop (customers, suppliers) need to see status?
