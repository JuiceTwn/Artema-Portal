# Artema Portal: plan

What we have decided, and what is still open. Update this as answers come in; the README is written from it.

## Decided

**Purpose.** One consolidated local portal for the people on the floor, instead of going between Monday.com, Excel and shared folders (and, for files, OneDrive). Simple enough for people who struggle with computers. The goal is the internal tool from quote to shipped door.

**What it should cover, in rough priority order**
1. A simpler Monday and Excel: everyone can see the work they need to do and what needs doing. Job tracking linked to the files for the job.
2. Fast. Monday is very slow at this scale; the Portal runs locally.
3. Finding and making SOPs more easily.
4. (Dream) A basic kanban inventory system, better and smarter than today's.

**People and machines.** About 30 people, roughly 16 to 20 computers. Every computer is used by many people through the week, so **there are no logins and no per-person accounts**. Nothing is tied to a particular PC either.

**Identity is the department.** What someone does is recorded as their *department* ("Paint", "Frame Prep"), picked in the app with a one-tap switcher that the browser remembers. Departments are for simplicity, not hiding: the shop works in the open.

**Access levels.** Three levels per computer: `general` (shop floor), `admin` (some in the office), `dev` (the developer). They say what a computer may *do* (settings, PIN, updates), not what it sees.

**Where it works.** Only inside the shop for now. Access from home or job sites can come later.

**Hosting.** The server runs locally and is not running yet, so there is nothing to migrate: the data model can be designed cleanly from the start.

## The production model

### The flow

```
Rail & Stile (provider) ─────────────────────────┐
Frame parts: cut in-house, or bought ──► Frame Prep ─┤
Panels: Skins ─► Panel Assembly (providers), or bought ┘
                                                     ▼
Frame Prep [ cut ─► CNC ─► fill ] ─► Paint [ paint prep ─► paint ] ─► Assembly ─► Ship
```

- **Frame Prep** is the shop's name for everything before paint, excluding providers. It is one department (a few people) with three tracked steps: **cut, CNC (frames and panels), fill**. Paint prep is *not* part of it: it belongs to Paint. Frame and panel aim to move to paint *together*.
- **Providers** are Skins, Panel Assembly and Rail & Stile (all internal), and any outside supplier. For the Portal an internal provider and an external supplier are the same thing: a *source* for a component, with an expected date and a "ready / received" event. Rail & Stile feeds the CNC.
- **Steps and QC.** Everything before a department's QC is a separate tracked step (Frame Prep: cut, CNC, fill; Paint: paint prep, paint). QC is not a step: every department ends with a QC check by its lead hand, and that sign-off is what completes the department's stage.
- **Release.** Ben / the office releases a door to start, after the other parts (glass, hardware, sill and so on) are in. Until there is real inventory, release uses a simple "parts in" tick list.

### Doors, components and projects

- A **door** is the unit of work. It is created from a door order form (the Excel in `Door Orders`) at intake; the form is the *source*, not the database.
- A door has **components** (at least frame and panel) that can come from different sources and at different times. A door is *ready for the next stage* when the components that stage needs have arrived. The Portal shows "frame ready, waiting on panel" instead of anyone checking.
- A **project** is a group of doors (Monday's "1 of 13"). Most work is single door orders. The order form's tag name can group doors automatically; a door with no project is simply on its own.

### Flow versus detours (rework)

A door has **one flow position**. Repairs never move it.

- **Flow.** Completing a stage records one completion for that door and stage. A door can only be counted once per stage, so throughput is never double counted.
- **Detour.** QC, or anyone, can send a door to any department for repair or rework. It appears in that department's queue marked as rework (rush, with the reason and the department that sent it), but it is not a stage completion and not a new system to track.
- While a detour is open, the door's flow position stays where it was and the board shows "In repair at <department>".
- When the repair is done the door returns to its original stage, ready to continue.
- Detours are measured separately: count per door and department, time in repair, reason. That shows which stage causes the most defects, without touching flow numbers.
- A detour can go to a department the door has already passed, and a door can have several.

### Who does what (without logins)

- A stage moves through *in progress → ready for QC → passed*. The lead hand's QC pass is the sign-off. The department switcher says which department is acting; an optional one-tap name list (lead hands) can record *who* signed off, and can be turned on per department. Nothing is remembered between taps.
- Releasing a door and editing job data is for the office. Moving doors along is for the floor.

### Departments in the app

Frame Prep (cut, CNC, fill), Paint (paint prep, paint), Assembly, Shipping, Office, plus the providers Skins, Panel Assembly and Rail & Stile (which feed components). Today's code has CNC, Frame Prep, Paint, Assembly and Office as flat departments with a work-order view each; CNC becomes a step of Frame Prep and Paint gains paint prep.

## Built so far

- Server build and client build from one codebase; join with a PIN over HTTPS; sync with trash and conflict copies.
- Per-computer access levels (`general`, `admin`, `dev`) in SQLite, with an API to assign them.
- Door orders read from the Excel forms, previewed, and laid out as a one-page work order per department (screen and PDF).
- **Job foundation:** `desktop/src/workflow.js` defines the flow and `desktop/src/jobs.js` keeps doors in SQLite (`jobs.db`): components and their sources, the parts-in checks and release, steps completed once per door with lead-hand QC, detours for repairs that never move or double count a door, projects ("5 of 13"), rework counts and an event log. Backups run on start and every 6 hours (`backup_dir` in the settings moves them to another disk); a damaged database is restored from the newest good backup and never silently replaced by an empty one. Tested by `npm test` (`scripts/e2e-jobs.js`).
- **Job screens and API:** `desktop/src/jobs-api.js` (`/api/jobs/...`) and `desktop/src/intake.js` (order form → door), with the screens in `desktop/web/jobs.js` and `jobs.css`. **My work** is a department's list: repairs first, then parts to make, then doors to do, each with one big button for the next step and an Undo toast instead of confirmations. **Board** shows every door in columns by department, with search and a "needs a look" filter. A door's side panel shows where it is, its parts, the release checklist, repairs and history. **Door orders** marks which forms are in the shop and adds them (asking where the frame, panel and rail & stile come from). The department is chosen in the app (one tap, remembered by the browser), with no login. Tested by `scripts/e2e-jobs-api.js` and by driving the screens in a headless browser.

## Direction change: editable status columns (from the Monday board)

The CNC board in Monday is not a fixed pipeline. It is a dense table with **status columns whose labels (name + colour) are editable dropdowns that admins can change at will** ("Edit Labels"), plus a timeline/date, files, an updates count and notes, in tabs per department, grouped, filtered and sorted. For example the CNC Frame labels are Ready, Done, Cutting Parts, Precut/Pre-assembly, CNC Parts, Ready for Pre-assembly, Verification Needed, Precut/Cladding, Filling/QC, Cut/Ready to Clad, Stuck; the CNC Panel labels include Large Format, Rail and stile, Lift and slide, Panel needs trimmed. Labels mix progress and product type.

So the board should be built on **configurable columns**: status columns with admin-editable label sets (add, rename, recolour, reorder, delete), date, text, files and door columns, set per cell with one tap on a colour palette, with admins also able to add or hide columns per department tab. The fixed step pipeline and detours built so far would become an optional layer driven by labels flagged "counts as done" or "needs a look", not the primary way to work. **Done:** the board is now built on these columns (see below).

**Built:** editable status columns (labels with a name, colour and optional "counts as done" / "needs a look" flags), date and text columns, tabs that choose which columns show (including details read from the order form), per-door comments ("updates") and notes, archiving, and a Customize screen for admins (only computers with the `admin` or `dev` role; permission `board.edit`). Anyone sets a cell with a one-tap colour palette. The guided steps (My work, release checklist, repairs) are an optional layer an admin switches on; they are off by default. Code: `desktop/src/columns.js`, `desktop/web/board.js`; tests in `scripts/e2e-jobs.js` and `scripts/e2e-jobs-api.js`. Starting columns copy the CNC board (CNC Timeline, CNC Frame, CNC Panel and their labels).

## Next steps, in order

1. **Foundation (model, event log, backups: done).** Still to do: retire `meta.json` / `activity.json` as stores, back up the shared files as well as the database, and test a restore on the real server.
2. **Intake and stages.** Excel form → door (with project grouping) → release → department queues and an office board. The first thing the shop can switch to; run it beside Monday for a pilot before switching.
3. **Job files.** A folder per door or project, file versions and restore, previews, and a "release to CNC" action that records what was sent.
4. **Live updates and notifications.** Boards update without reloading; a department is told when work arrives.
5. **Reports, then SOPs, then inventory.** Throughput, on-time ship rate and rework per department. SOPs linked to a stage. A kanban inventory on top of the door and parts data.
6. **Remote access** and other integrations.

## Open (not decided yet)

**Flow**
- Whether Assembly and Shipping also have inner steps worth tracking.
- Where exactly the frame and panel are paired before paint, and what happens when one is late.
- Whether every door has the same components, or it varies by product (sidelights, transoms, glass).

**Jobs**
- Whether to bring existing Monday jobs over or start fresh (leaning towards a clean start, with a one-off import only if wanted).
- Other order types besides doors (windows, repairs, custom).

**Departments**
- Whether the optional name tap on sign-offs is wanted, and for which departments.

**SOPs**
- Where they live, what format (documents, checklists, photos, video), and who may write or edit them.

**Inventory / kanban**
- What is tracked, what a "card" is, and what triggers a reorder. Needs its own conversation.

**Files and the CNC**
- Which machines and controllers, and how each one reads files today (USB, network folder, its own software).
- Whether file versions or history are needed beyond restore.

**Running it**
- Which computer hosts the server (dedicated, always on, UPS, fixed address) and where backups go.
- Exact number of computers and which ones are Macs or tablets, if any.
- What happens when the main computer is off: how long can the shop wait?
- How updates should reach every computer (automatic, or approved first).
- Branding: logo, colours, wording.

**Code housekeeping**
- A screen to assign access levels (today only the API).
- Keep, archive or remove the old Python prototype in the repo root, and the duplicate `web/` folder.
