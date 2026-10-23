# Artema Portal: plan

What we have decided, and what is still open. Update this as answers come in; the README is written from it.

## Decided

**Purpose.** One consolidated local portal for the people on the floor, instead of going between Monday.com, Excel and shared folders. Simple enough for people who struggle with computers.

**What it should cover, in rough priority order**
1. A simpler Monday and Excel: everyone can see the work they need to do and what needs doing. Job tracking linked to the files for the job.
2. Fast. Monday is very slow at this scale; the Portal runs locally.
3. Finding and making SOPs more easily.
4. (Dream) A basic kanban inventory system, better and smarter than today's.

**People and machines.** About 30 people, roughly 16 to 20 computers (to be confirmed).

**Access.** Three levels per computer: `general` (shop floor), `admin` (some in the office), `dev` (the developer). On top of those, **departments** change what each person sees by default, to make workflows obvious. They are for simplicity, not hiding: the shop believes in transparency.

**Where it works.** Only inside the shop for now. Access from home or job sites can come later and is considered easy to add.

**First real use.** A simpler Monday and Excel: the same computers show people the work they need to do, and what needs doing. (The user said this is hard to pin down yet.)

## Built so far

- Server build and client build from one codebase; join with a PIN over HTTPS; sync with trash and conflict copies.
- Per-computer access levels (`general`, `admin`, `dev`) in SQLite, with an API to assign them.

## Open (not decided yet)

**Jobs (the Monday part)**
- What a job is in the Portal, what fields it has, and which statuses it moves through.
- How jobs link to files (a folder per job?).
- Whether and how to bring existing Monday jobs over, or start fresh.
- How the floor sees "my work" and "what's next": one screen per department?

**Departments**
- The list of departments, and what each one's default view should show.
- Whether a department belongs to a computer (a shared shop PC) or to a person (needs logins).

**SOPs**
- Where they live, what format (documents, checklists, photos, video), and who may write or edit them.

**Inventory / kanban**
- What is tracked, what a "card" is, and what triggers a reorder. Needs its own conversation.

**Files and the CNC**
- Which machines and controllers, and how each one reads files today (USB, network folder, its own software).
- Whether file versions or history are needed.

**Running it**
- Exact number of computers and which ones are Macs or tablets, if any.
- What happens when the main computer is off: how long can the shop wait?
- Backups of the shared files and the databases.
- How updates should reach every computer (automatic, or approved first).
- Branding: logo, colours, wording.

**Code housekeeping**
- A screen to assign access levels (today only the API).
- Keep, archive or remove the old Python prototype in the repo root.
