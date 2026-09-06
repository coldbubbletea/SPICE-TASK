## 1. Backend scaffolding (experiment-api)
- [ ] 1.1 Create `probe/web/__init__.py`, `probe/web/server.py` (FastAPI app + static mount) and one-click start script `scripts/run_console.py` (uvicorn + auto-open browser)
- [ ] 1.2 Implement job registry (`probe/web/registry.py`): create/list jobs, per-task stage transitions, JSON persistence under `results/jobs/`
- [ ] 1.3 Implement API routes: POST `/api/jobs` (benchmark or ad-hoc), GET `/api/jobs`, GET `/api/jobs/{id}`, GET `/api/jobs/{id}/tasks/{task}/artifacts`, GET `/api/results`

## 2. Result ingestion (result-ingestion)
- [ ] 2.1 Implement `probe/web/ingest.py`: scan jobs roots, parse `reward.json`/`result.json`/`model.patch`, skip incomplete trials
- [ ] 2.2 Label imported runs by jobs-root name; persist ingested results to `results/ingested/`

## 3. Ad-hoc repair wiring (ad-hoc-repair)
- [ ] 3.1 Workspace validation + sandbox copy into `results/adhoc/<job-id>/ws/`
- [ ] 3.2 Wire ad-hoc jobs through PROBE pipeline (prober → repairer → scorer with user test commands, before/after)
- [ ] 3.3 Generate unified diff of the sandbox copy as the downloadable patch

## 4. Frontend (console-ui)
- [ ] 4.1 Create `probe/web/static/index.html` + `style.css` (dark lab aesthetic, single page, no build step)
- [ ] 4.2 Overview dashboard: baseline × task grid with resolved flags and pass counts
- [ ] 4.3 Launch panel with two modes (benchmark baselines+tasks / ad-hoc workspace+bug+tests), one-click start, live stage polling
- [ ] 4.4 Task/job detail view: problem statement, patch (downloadable for ad-hoc), probe report, before/after scores

## 5. Verification
- [ ] 5.1 Screenshot QA of overview + launcher + detail views (headless Chrome)
- [ ] 5.2 Smoke test API endpoints with curl (ingested B0 data visible; stub job lifecycle)
