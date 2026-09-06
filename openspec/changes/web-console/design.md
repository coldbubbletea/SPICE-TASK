## Context

PROBE core (pipeline, agents, scorer) is being built in parallel (`probe-foundation`). The console must not block on it: it should work today by ingesting existing B0 job artifacts, support ad-hoc mode once the pipeline exists, and degrade gracefully in between. FastAPI + uvicorn are already installed; no frontend build tooling is desired (keep it clone-and-run).

## Goals / Non-Goals

**Goals:**
- One command → browser opens a working console showing real historical B0 results immediately.
- Two launch modes behind one panel: benchmark subset runs and ad-hoc workspace+bug repairs.
- Live status for active jobs via lightweight polling (no websockets dependency).
- Self-contained static frontend (one `index.html` + `app.js` + `style.css`) served by FastAPI.

**Non-Goals:**
- No auth/multi-user; single local user on localhost.
- No build step, no npm, no framework — vanilla JS keeps it dependency-free and diffable.
- No remote workspace support (local directories only for now).
- No replacement for CLI; console is additive.

## Decisions

- **FastAPI + static serving.** One process serves both API (`/api/*`) and the SPA (`/`). *Alternative:* separate static server — rejected, one command is a requirement.
- **Polling over websockets.** `GET /api/jobs/{id}` every ~2s while active. Simpler, robust, adequate for run durations of minutes.
- **Unified job model.** Both benchmark runs and ad-hoc repairs are "jobs" with per-task stages (`probing` → `repairing` → `scoring` → `done`), so one UI panel and one status endpoint cover both modes.
- **Ad-hoc sandboxing.** The user workspace is copied into `results/adhoc/<job-id>/ws/` before any agent touches it; the patch is generated as a diff of that copy, so the original directory is never modified.
- **Ingestion at startup + on demand.** On boot, scan configured jobs roots into an in-memory store (persisted under `results/ingested/`); refresh endpoint re-scans.

## Risks / Trade-offs

- Ad-hoc mode depends on PROBE core; until the pipeline lands, that panel shows a disabled state with a clear message rather than failing.
- In-memory job state is lost on crash; mitigated by persisting per-task stage transitions to disk.
- Arbitrary user test commands execute locally — acceptable for a single-user research tool, but documented as such.
- Console is only as correct as the scorer/pipeline it wraps — dogfood with task_086 first.
