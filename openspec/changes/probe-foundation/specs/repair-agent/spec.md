## Purpose

Define Agent B (Repair Agent) behavior: produce a code patch that fixes the target defect, using invariant-probe results when available and test-generation guidance for baselines.

## ADDED Requirements

### Requirement: Patch production from probe report
When given a task plus an invariant-probe report, Agent B SHALL produce a single code patch intended to make all reported failing probes pass while preserving existing passing behavior.

#### Scenario: Multi-path fix
- **WHEN** the probe report shows failures on two independent paths of one bug class
- **THEN** the produced patch addresses both paths rather than only the first observed failure

#### Scenario: Patch applies cleanly
- **WHEN** Agent B emits a patch
- **THEN** it is in an applicable diff format that can be applied to the repository without manual editing

### Requirement: Baseline repair modes
Agent B SHALL support operating under different prompt configurations so that baselines B0 (vanilla) and B1 (single-agent + "generate more tests") can reuse the same repair implementation.

#### Scenario: Vanilla mode
- **WHEN** Agent B runs in B0 configuration
- **THEN** it repairs from the problem statement alone with no probe report or test-generation instruction

#### Scenario: Test-generation-guided mode
- **WHEN** Agent B runs in B1 configuration
- **THEN** its instructions direct it to construct additional test cases before repairing, using a single agent
