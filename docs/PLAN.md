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
Frame Prep [ cut ─► CNC ─► fill ─► paint prep ] ─► Paint ─► Assembly ─► Ship
```

- **Frame Prep** is the shop's name for everything before paint, excluding providers. It is one department (a few people) covering cutting, running the CNC (frames and panels), filling and paint prep. Frame and panel aim to move to paint *together*.
- **Providers** are Skins, Panel Assembly and Rail & Stile (all internal), and any outside supplier. For the Portal an internal provider and an external supplier are the same thing: a *source* for a component, with an expected date and a "ready / received" event. Rail & Stile feeds the CNC.
- **QC is not a stage.** Every department ends with a QC check by its lead hand, and that sign-off is what completes the department's stage.
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

Frame Prep, Paint, Assembly, Shipping, Office (the stages and the views), plus the providers Skins, Panel Assembly and Rail & Stile (which feed components). Today's code has CNC, Frame Prep, Paint, Assembly and Office, with work-order views per department. Whether Frame Prep's inner steps (cut, CNC, fill, paint prep) are tracked separately or as one stage is open below.

## Built so far

- Server build and client build from one codebase; join with a PIN over HTTPS; sync with trash and conflict copies.
- Per-computer access levels (`general`, `admin`, `dev`) in SQLite, with an API to assign them.
- Door orders read from the Excel forms, previewed, and laid out as a one-page work order per department (screen and PDF).

## Next steps, in order

1. **Foundation.** A SQLite job model on the server: doors, components and sources, projects, stage completions, detours, and an event log. Retire `meta.json` / `activity.json` as stores. Attribution by department (and the optional name tap). Scheduled backups with a tested restore.
2. **Intake and stages.** Excel form → door (with project grouping) → release → department queues and an office board. The first thing the shop can switch to; run it beside Monday for a pilot before switching.
3. **Job files.** A folder per door or project, file versions and restore, previews, and a "release to CNC" action that records what was sent.
4. **Live updates and notifications.** Boards update without reloading; a department is told when work arrives.
5. **Reports, then SOPs, then inventory.** Throughput, on-time ship rate and rework per department. SOPs linked to a stage. A kanban inventory on top of the door and parts data.
6. **Remote access** and other integrations.

## Open (not decided yet)

**Flow**
- Does Frame Prep track its inner steps (cut, CNC, fill, paint prep) as separate stages, or is it one stage with one QC at the end? Separate steps give better numbers but more taps for a small team.
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
