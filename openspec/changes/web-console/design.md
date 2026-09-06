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
- No SSR/Next.js — client-side SPA is sufficient for a local tool.
- No remote workspace support (local directories only for now).
- No replacement for CLI; console is additive.

## Decisions

- **React 18 + TypeScript + Vite.** World's most popular frontend stack. Vite builds to static `dist/` which FastAPI serves at `/`. Type safety across the API boundary via generated types. *Alternative considered:* vanilla JS (simpler, but no type safety and poor DX for growing UI); Svelte (lighter runtime, but smaller ecosystem).
- **FastAPI + static serving.** One process serves both API (`/api/*`) and the built SPA (`/`). *Alternative:* separate static server — rejected, one command is a requirement.
- **Polling over websockets.** `GET /api/jobs/{id}` every ~2s while active. Simpler, robust, adequate for run durations of minutes.
- **Unified job model.** Both benchmark runs and ad-hoc repairs are "jobs" with per-task stages (`probing` → `repairing` → `scoring` → `done`), so one UI panel and one status endpoint cover both modes.
- **Ad-hoc sandboxing.** The user workspace is copied into `results/adhoc/<job-id>/ws/` before any agent touches it; the patch is generated as a diff of that copy, so the original directory is never modified.
- **Ingestion at startup + on demand.** On boot, scan configured jobs roots into an in-memory store (persisted under `results/ingested/`); refresh endpoint re-scans.
- **User-configurable LLM endpoint.** API config (base URL / key / model) lives in `results/config.json`, owned by the user not the code. The agent runner reads it at job start; a connectivity-test endpoint sends one minimal chat completion before any job runs. *Alternative considered:* hardcoded local Qwen endpoint — rejected because users must bring their own API (the whole point of ad-hoc mode).

## Risks / Trade-offs

- Ad-hoc mode depends on PROBE core (prober/repairer/scorer from `probe-foundation`); until the pipeline lands, jobs stay in `pending` and the UI shows a clear "engine not installed" notice. API config + workspace selection work regardless.
- In-memory job state is lost on crash; mitigated by persisting per-task stage transitions to disk.
- Arbitrary user test commands execute locally — acceptable for a single-user research tool, but documented as such.
- Console is only as correct as the scorer/pipeline it wraps — dogfood with task_086 first.
