## Context

PROBE is a standalone research harness (Python) for evaluating two-agent automated program repair on SWE-bench Science. It consumes external task data at `/home/satoru/swe-bench-science/` and calls a local model endpoint (`http://127.0.0.1:8888/v1`, Qwen3.8-27B). There is no product runtime; the deliverable is reproducible experiments plus per-task artifacts that feed a 4-page report. The motivating evidence is task_086, where two independent code paths of one bug class must both be fixed for private tests to pass — a single agent fixes only the path it sees.

## Goals / Non-Goals

**Goals:**
- Reproduce B0 (vanilla single-agent) and run B1 (single-agent + test-generation prompt) and B2 (PROBE two-agent) over the false-green subset.
- Make Agent A's probe set genuinely expose multiple entry points, not just confirm a known fix.
- Produce clean per-task artifacts (patch, probe report, scores) under `results/` for analysis.
- Keep the repair implementation shared across baselines so differences are attributable to prompt/agent topology, not code.

**Non-Goals:**
- Not a general-purpose SWE-bench runner; scoped to the false-green subset and the three baselines.
- No model training or fine-tuning.
- No GUI/dashboards; CLI + files only.

## Decisions

- **Shared `agent_runner` layer.** A single LLM execution abstraction (chat/completions against the local endpoint) backs Agent A, Agent B, and both baselines. Baseline differences live in prompts/configs, not in duplicated runners. *Alternative:* separate runner per baseline — rejected to keep behavior comparable.
- **Probes are executable checks, not prose.** Agent A emits runnable tests/checks plus a structured report (probe id, targeted path label, pass/fail on the unmodified repo). This makes "exposed multiple entry points" measurable rather than asserted. *Alternative:* free-form analysis text — rejected because it is not verifiable and cannot be scored.
- **B2 passes only Agent A's report to Agent B.** The repair agent sees probe outcomes, not a target patch, preserving the adversarial separation that motivates PROBE.
- **Config-driven baselines** (`configs/b0_vanilla.yaml`, `b1_testgen.yaml`, `b2_probe.yaml`) select pipeline topology and prompt files; unknown ids fail fast.
- **Per-task isolation.** Each task runs in its own sandboxed copy of the repo; a failure is recorded, not propagated.

## Risks / Trade-offs

- **Probe coverage is bounded by Agent A's model** — it may miss an entry point, so B2 can still under-fix. Mitigation: report which paths were probed so gaps are visible in analysis.
- **Cost/latency doubles for B2** (two agent passes). Accepted as the core trade-off under test.
- **Local endpoint availability** is a hard dependency; runs fail if the server is down. Run scripts should preflight the endpoint.
- **Abandonment-type tasks (e.g. 090)** may see little benefit from probing; expected and called out in report limitations.
