## Purpose

Import existing SWE-bench Science job artifacts into the console's result store so historical runs (e.g. B0) are visible without re-running them.

## ADDED Requirements

### Requirement: Job directory import
The ingestion layer SHALL scan a jobs root for trial directories and read `reward.json`, `result.json`, and `artifacts/model.patch` when present.

#### Scenario: Import a completed trial
- **WHEN** ingestion processes a trial dir containing `verifier/reward.json` and `result.json`
- **THEN** it records the task id, public/private pass counts, resolved flag, and patch path for that trial

#### Scenario: Skip incomplete trials
- **WHEN** a trial dir lacks `reward.json`
- **THEN** ingestion skips it without failing the overall scan

### Requirement: Baseline attribution
Ingestion SHALL label imported runs with a baseline identifier derived from the jobs root name.

#### Scenario: Label by root
- **WHEN** trials under `.../codex-6tasks-085-090-deepseek-v4pro/` are imported
- **THEN** their results carry that run's label as the baseline identifier in the console
