# Automated Handling System

Command center for all of Paris Pehlivanovic's projects: a dashboard of last-known
project statuses, a decisions queue ("needs your word"), automations, and an
activity feed. Standalone rebuild (v2.0) of the hosted Automated Handling System.

## What it does

- **Projects** — each of the 7 projects with its last-known status, headline
  metric, and the date that status was last verified. Statuses here are
  **snapshots, not live data**: nothing in this app polls the underlying
  systems. Each card shows its source date.
- **Decisions** — the queue of items waiting on Paris's word. Each decision can
  be Approved, marked Done, Deferred (back in the queue), or Dismissed.
  Deleting a decision is permanent and needs a two-step confirmation.
- **Automations** — the 15 automations across the projects, with full editing
  (name, kind, schedule, detail, status) and per-project health bars.
- **Activity** — a running log; new notes can be added per project.
- **Archive / restore** — projects can be archived off the dashboard and
  restored reversibly.
- **Export** — one tap downloads the full state as JSON or as a Markdown report.
- **Search & filters** — global search (press `/` to focus), status and
  urgency filters, project sorting, decision age badges.
- **Extras** — sticky command bar with a live status pill, confirm dialogs,
  toast feedback, loading skeleton, light/dark mode, keyboard accessibility.

## Run it

Requires Node.js (no dependencies to install — standard library only).

```sh
node server.js
```

Then open http://localhost:3000. Override the port with `PORT`:

```sh
PORT=8080 node server.js
```

## Data

On first run the server copies `data/seed.json` to `data/data.json` and all
writes go to `data/data.json`. `data/data.json` is gitignored; `data/seed.json`
is the committed starting state (the 7 projects, 11 pending decisions,
15 automations, and 5 activity entries as of 2026-11-18). To reset to the
seed state, stop the server and delete `data/data.json`.

## API

- `GET /api/dashboard` — projects, pending + resolved decisions, automations, activity, counts
- `GET /api/archived` — archived projects
- `GET /api/export?format=json|md` — full export (JSON or Markdown)
- `POST /api/decisions` — add a decision (`title`, `context`, `urgency`, `projectId`)
- `POST /api/decisions/:id/resolve` — `{"status": "approved"|"done"|"deferred"|"dismissed"}`
- `POST /api/decisions/:id/delete` — needs `{"confirm": true}` (two-step)
- `POST /api/automations` / `PUT /api/automations/:id` / `POST /api/automations/:id/delete`
- `POST /api/projects` / `PUT /api/projects/:id`
- `POST /api/projects/:id/archive` / `POST /api/projects/:id/restore`
- `POST /api/activity` — add a note (`text`, optional `projectId`)

Every write that names a `projectId` is rejected with a 400 if the project
does not exist.

## License

All rights reserved. See LICENSE.
