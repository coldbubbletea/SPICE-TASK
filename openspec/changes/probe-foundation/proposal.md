## Why

Single-agent repair of scientific code systematically "fixes the one path it sees and stops." On SWE-bench Science, this produces false greens: a task's public tests pass while private tests fail because the same bug class is reachable through multiple entry points (e.g. task_086, where fixing only one of two independent code paths leaves the other broken). We need a method that exposes all entry points of a bug before repair, so the fix is complete rather than path-local.

## What Changes

- Introduce a two-agent pipeline **PROBE**: an Invariant Prober (Agent A) generates adversarial invariant probes / extra tests against a codebase to expose multiple entry points of the same bug class; a Repair Agent (Agent B) repairs using those probe results.
- Add task loading for SWE-bench Science instances, restricted to the "public passes / private fails" false-green subset (initially tasks 085–090).
- Add an evaluation/scoring layer computing F2P/P2P pass counts and a resolved flag per task.
- Add experiment orchestration supporting three baselines: B0 (vanilla single-agent), B1 (single-agent + "generate more tests" prompt), B2 (PROBE two-agent), driven by declarative configs.
- Provide reproducible run scripts for the full subset and for a single task.

## Capabilities

### New Capabilities
- `task-loading`: Load SWE-bench Science task instances and select the false-green experimental subset.
- `invariant-probing`: Agent A behavior — generate invariant probes / extra tests that expose multiple entry points of a bug class.
- `repair-agent`: Agent B behavior — produce a code patch using probe results (and, for baselines, test-generation guidance).
- `experiment-pipeline`: Orchestrate the B0/B1/B2 pipelines end to end from config, one task at a time.
- `evaluation-scoring`: Score a candidate patch against public/private tests and compute pass counts and a resolved flag.

### Modified Capabilities
<!-- none: this is a greenfield change -->

## Impact

- New Python package `probe/` (pipeline, prober, repairer, agent_runner, evaluation, data, prompts).
- New declarative configs under `configs/` and run scripts under `scripts/`.
- Depends on the local model endpoint (`http://127.0.0.1:8888/v1`) and the SWE-bench Science task data at `/home/satoru/swe-bench-science/`.
- No changes to existing repositories; PROBE is a standalone harness that consumes external task data and model output.
