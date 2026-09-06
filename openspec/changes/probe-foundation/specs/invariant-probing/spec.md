## Purpose

Define Agent A (Invariant Prober) behavior: generate adversarial invariant probes and extra tests that expose multiple entry points of the same bug class before any repair is attempted.

## ADDED Requirements

### Requirement: Invariant probe generation
Given a task's problem statement and repository, Agent A SHALL produce a set of invariant probes — executable checks or additional tests — targeting behaviors the stated bug may violate across different code paths.

#### Scenario: Probes target multiple entry points
- **WHEN** the same defect is reachable through two distinct code paths
- **THEN** the generated probe set includes at least one check that exercises each path independently

#### Scenario: Probes are executable
- **WHEN** a probe is emitted
- **THEN** it is runnable against the repository without modification and reports pass/fail

### Requirement: Probe independence from repair
Agent A SHALL generate probes without being instructed to make any specific test pass, so that its output reflects genuine exposure of defects rather than confirmation of a known fix.

#### Scenario: No repair bias
- **WHEN** Agent A runs for a task
- **THEN** its prompt and instructions do not reference the intended fix or a target patch

### Requirement: Probe result report
Agent A SHALL emit a structured report listing each probe, the code path it targets, and its pass/fail outcome on the unmodified repository.

#### Scenario: Report structure
- **WHEN** probing completes for a task
- **THEN** the report contains one entry per probe with an identifier, targeted path label, and boolean outcome
