## Purpose

Score a candidate patch against a task's public and private tests and reduce the outcomes to pass counts and a resolved flag for reporting.

## ADDED Requirements

### Requirement: Public/private test scoring
Given an applied patch, the scorer SHALL execute the task's public tests and private tests separately and report pass/fail counts for each group.

#### Scenario: Count both groups
- **WHEN** a patch is scored for a task with 1 public and 4 private tests
- **THEN** the result reports separate public and private pass counts (e.g. `public=1/1`, `private=4/4`)

### Requirement: Resolved determination
The scorer SHALL mark a task resolved if and only if all of its public and private tests pass under the candidate patch.

#### Scenario: Fully passing is resolved
- **WHEN** public and private tests all pass
- **THEN** the resolved flag is true

#### Scenario: Partial pass is not resolved
- **WHEN** any public or private test fails
- **THEN** the resolved flag is false, even if the public group fully passes

### Requirement: Machine-readable result record
The scorer SHALL emit a machine-readable record containing task id, baseline id, public counts, private counts, and the resolved flag.

#### Scenario: Record fields present
- **WHEN** scoring completes
- **THEN** the emitted record includes `task_id`, `baseline`, `public_pass`, `private_pass`, and `resolved`
