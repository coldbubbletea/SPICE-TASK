## Purpose

Orchestrate the B0/B1/B2 pipelines end to end from declarative configuration, running each selected task independently and collecting artifacts for evaluation.

## ADDED Requirements

### Requirement: Config-driven baseline selection
The pipeline SHALL select which baseline(s) to run (B0, B1, B2) from a config file, and SHALL reject unknown baseline identifiers.

#### Scenario: Run a single configured baseline
- **WHEN** a config names baseline `b2_probe`
- **THEN** the pipeline runs only the PROBE two-agent flow for the selected tasks

#### Scenario: Unknown baseline
- **WHEN** a config references an undefined baseline id
- **THEN** the pipeline fails fast with an error naming the unknown id

### Requirement: Two-agent sequencing for B2
For baseline B2, the pipeline SHALL run Agent A (probing) to completion before starting Agent B (repair), passing Agent A's report into Agent B.

#### Scenario: Probe-then-repair ordering
- **WHEN** B2 runs for a task
- **THEN** Agent B receives the invariant-probe report produced by Agent A for that same task

### Requirement: Per-task isolation and resumability
The pipeline SHALL treat each task independently so one task's failure does not abort the rest, and SHALL write per-task artifacts to `results/`.

#### Scenario: Failure isolation
- **WHEN** a baseline run fails for one task in the subset
- **THEN** the remaining tasks still run and their results are recorded

#### Scenario: Artifact persistence
- **WHEN** a baseline completes for a task
- **THEN** its patch, probe report (if B2), and scores are written under `results/` keyed by task and baseline
