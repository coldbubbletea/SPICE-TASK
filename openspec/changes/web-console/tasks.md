## 1. Backend scaffolding (experiment-api)
- [x] 1.1 Create `probe/web/__init__.py`, `probe/web/server.py` (FastAPI app + static mount) and one-click start script `scripts/run_console.py` (uvicorn + auto-open browser)
- [x] 1.2 Implement job registry (`probe/web/registry.py`): create/list jobs, per-task stage transitions, JSON persistence under `results/jobs/`
- [ ] 1.3 Implement API routes: POST `/api/jobs` (benchmark or ad-hoc), GET `/api/jobs`, GET `/api/jobs/{id}`, GET `/api/jobs/{id}/tasks/{task}/artifacts`, GET `/api/results`
- [ ] 1.4 Implement LLM config endpoints: GET/PUT `/api/config` (persist to `results/config.json`), POST `/api/config/test` (minimal chat-completion connectivity check)

## 2. Result ingestion (result-ingestion)
- [ ] 2.1 Implement `probe/web/ingest.py`: scan jobs roots, parse `reward.json`/`result.json`/`model.patch`, skip incomplete trials
- [ ] 2.2 Label imported runs by jobs-root name; persist ingested results to `results/ingested/`

## 3. Ad-hoc repair wiring (ad-hoc-repair)
- [ ] 3.1 Workspace validation + sandbox copy into `results/adhoc/<job-id>/ws/`
- [ ] 3.2 Wire ad-hoc jobs through PROBE pipeline (prober → repairer → scorer with user test commands, before/after)
- [ ] 3.3 Generate unified diff of the sandbox copy as the downloadable patch

## 4. Frontend — React + TypeScript + Vite (console-ui)
- [ ] 4.1 Scaffold `web/` with Vite + React 18 + TypeScript (`npm create vite@latest web -- --template react-ts`)
- [ ] 4.2 Dark lab theme (CSS variables, no UI framework — custom components for full control)
- [ ] 4.3 **Repair panel (hero)**: guided flow pick-workspace → configure-API (base URL/key/model + test-connection button) → describe-bug → Start; Start disabled with inline hints until ready
- [ ] 4.4 Overview dashboard: baseline × task grid with resolved flags and pass counts (ingested B0 data)
- [ ] 4.5 Live job view: per-task stage chips (probing/repairing/scoring/done), polling every 2s
- [ ] 4.6 Task/job detail view: problem statement, patch (downloadable for ad-hoc), probe report, before/after scores
- [ ] 4.7 Wire Vite build output to FastAPI static serving; add `npm run build` to CI before PyInstaller

## 5. Desktop shell & packaging (desktop-shell)
- [ ] 5.1 Add `probe/web/desktop.py`: pywebview window that boots the FastAPI server in-process and opens the console URL
- [ ] 5.2 PyInstaller spec for Windows + Linux producing a single-folder dist with app icon
- [ ] 5.3 GitHub Actions workflow (`.github/workflows/release.yml`): matrix build windows/amd64 + ubuntu/x86_64, attach zips to the release

## 6. Verification
- [ ] 6.1 Screenshot QA of overview + launcher + detail views (headless Chrome)
- [ ] 6.2 Smoke test API endpoints with curl (ingested B0 data visible; stub job lifecycle)
- [ ] 6.3 Verify packaged app boots server and cleans up on close (Linux locally; Windows via CI artifact)
