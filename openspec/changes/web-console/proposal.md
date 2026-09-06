## Why

PROBE is currently a CLI-only research harness. We want a web console where a user can, with one click: (a) run benchmark experiments over the SWE-bench Science false-green subset and inspect patches/probes/scores, and (b) point PROBE at their own code workspace plus a bug description and get a repaired patch — no terminal required. The same UI also serves as the workflow figure for the report.

## What Changes

- Add a FastAPI backend (`probe/web/`) exposing experiment control, ad-hoc repair jobs, and result queries as JSON endpoints.
- Add a single-page frontend (vanilla HTML/CSS/JS, no build step) with a dark "lab" aesthetic: overview dashboard, run launcher, live progress, per-task detail views.
- Add an **ad-hoc repair mode**: the user selects a local code workspace (directory), writes a bug description, optionally adds their own test commands; PROBE runs probing + repair against it and returns a patch plus before/after test results.
- Add an ingestion layer that imports existing SWE-bench Science job artifacts (`reward.json`, `ctrf.json`, `result.json`, `model.patch`) so historical B0 runs appear immediately.
- Add a desktop shell (pywebview window embedding the console) packaged with PyInstaller into out-of-the-box archives for Windows (amd64) and Linux (x86_64), built by GitHub Actions.
- One-click usage: users unzip a release archive and double-click `PROBE` — no Python/Node install; a single command (`scripts/run_console.py`) also works for developers.

## Capabilities

### New Capabilities
- `console-ui`: The one-page web interface — dashboard, launcher (benchmark + ad-hoc modes), live status, task detail with patch/probe/score views.
- `experiment-api`: JSON API for launching runs (baseline + benchmark tasks or ad-hoc workspace/bug jobs) and polling status/artifacts.
- `result-ingestion`: Import existing job directories (reward/ctrf/result/patch) into the console's result store.
- `ad-hoc-repair`: Repair a user-supplied local workspace from a bug description, with optional user-provided test commands and before/after comparison.
- `desktop-shell`: Out-of-the-box Windows/Linux desktop app (unzip-and-run) wrapping the console with an embedded server.

### Modified Capabilities
<!-- none -->

## Impact

- New `probe/web/` package (server, api, registry, ingest) and `probe/web/static/` frontend assets.
- Ad-hoc mode depends on the PROBE core pipeline (`probe-foundation` change): prober + repairer + scorer must exist for full functionality; the console degrades gracefully (shows what is available) until then.
- New dependency usage: fastapi + uvicorn (already installed).
- Console reads/writes only under `results/`; ad-hoc mode copies the user workspace into a sandbox dir before any modification so the original stays untouched.
