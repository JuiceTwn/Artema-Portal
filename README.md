# Artema Portal

One simple, local portal for the Artema shop floor, to use instead of jumping between Monday.com, Excel and shared folders.

It runs on the shop's own computers, so it is fast, and it is built to be easy for people who don't like computers.

## What it is for

- **See the work.** Everyone on the floor can open the Portal and see the jobs they need to do and what needs doing next.
- **Move files.** Drawings and CNC files go from the office to the machines (the original reason this exists), with no USB sticks or shared-drive hunting.
- **Find and write SOPs.** Standard operating procedures should be easy to find and easy to make.
- **Later: a better inventory.** A basic kanban-style system to replace the inventory system the shop doesn't really have today.

Why not Monday: it is very slow at the shop's size, and it keeps job tracking apart from the files the jobs need.

## Who it is for

About 30 people on roughly 16 to 20 computers: the floor, the office, the CNC machines. The shop is open about its work, so the Portal does not hide things. It makes the right view obvious, so finding and tracking a job is simple.

## Where it stands today

The foundation works. The job tracking, SOP and inventory parts are not built yet.

| Works now | Not built yet |
|---|---|
| One main computer (the server) holds the shared files | Jobs and statuses (the "Monday" part) |
| Other computers connect to it with a PIN and stay in sync | SOPs |
| Everything is encrypted (HTTPS); computers trust the exact main computer they joined | Inventory / kanban |
| Three access levels per computer: `general`, `admin`, `dev` | Department views |
| Trash for deleted files, conflict copies instead of overwrites | A screen to assign access levels (API only for now) |
| Runs only inside the shop network | Access from home or job sites |

## How it is built

- **Two builds from one codebase.** The **server** build is always the main computer: it sets itself up on first start and can never join another one. The **client** build connects to the server and can never be one. The build decides, so an update can't switch a computer's role.
- **Desktop app** (Electron) for Windows, in `desktop/`. It lives in the tray and keeps syncing in the background.
- **Access levels** are stored per computer in a small SQLite database that survives crashes and power cuts. If it is ever damaged, nobody gets extra access.
- `desktop/src/` is the engine, `desktop/web/` is what people see, `desktop/scripts/` has the build and the tests.
- The root of the repo still holds the original Python prototype. It is not used by the desktop app.

### Access levels and departments

Two separate ideas, kept apart on purpose:

- **Access level** (`general`, `admin`, `dev`) says what a computer is *allowed to do*: manage computers, see the PIN, and so on. `general` is the shop floor, `admin` is the office, `dev` is for development.
- **Department** (planned) says what a person or computer *sees first*: the views and workflows that make sense for their work. It is for simplicity, not secrecy. Nothing is hidden because of a department.

### Updates

Installing a new **server** is the only manual step. The server build carries a copy of the client app, and every connected computer
checks for it every few minutes, downloads only the files that changed, verifies each one, and installs it when nobody is looking at
the window. If the new version crashes on start, the old one is put back.

- Updates only ever come from the main computer a client joined (over its pinned connection), and only move forward. A client never installs the same or an older version.
- If a new version needs a newer Electron runtime, clients show that it needs a full reinstall from the server's client zip instead of updating.
- Running a newly downloaded copy over an older installed one closes the old one and replaces the install, so nothing stale is left behind.

## Install

Build the zips (Windows):

```
cd desktop
npm ci
npm run dist
```

This makes two zips in `desktop/dist/`:

- `server/Artema-Portal-Server-<version>-win.zip` for the one main computer (it also carries the client, for updates)
- `client/Artema-Portal-<version>-win.zip` for every other computer, the first time only

Unzip and run the `.exe`. The first run installs it for that Windows user, adds shortcuts, and starts with Windows. The server shows a PIN under **Setup and status**. A client finds the server on its own and asks for that PIN once.

`npm run dist:server` and `npm run dist:client` build one each. Set `ARTEMA_VERSION` to stamp a test version.

## Test

```
cd desktop
npm test
```

Runs the end-to-end suites: file sync, certificate and multi-server cases, the two builds, and access levels.

## More

The plan, the decisions made so far, and what is still open are in [docs/PLAN.md](docs/PLAN.md).
