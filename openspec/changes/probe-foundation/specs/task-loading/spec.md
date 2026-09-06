## Purpose

Load SWE-bench Science task instances from disk and select the false-green experimental subset so experiments run over a well-motivated, reproducible set of tasks.

## ADDED Requirements

### Requirement: Task instance loading
The system SHALL load a SWE-bench Science task instance by identifier and expose its problem statement, repository location, public test list, and private test list.

#### Scenario: Load a known task
- **WHEN** a loader is given the identifier `task_086`
- **THEN** it returns the instance with non-empty problem statement, repo path, and both public and private test lists

#### Scenario: Unknown identifier
- **WHEN** a loader is given an identifier that does not exist in the dataset
- **THEN** it raises a distinct error identifying the missing task rather than returning partial data

### Requirement: False-green subset selection
The system SHALL select the experimental subset as tasks whose public tests pass but private tests fail under the baseline (B0) run, and SHALL expose the selected identifiers.

#### Scenario: Select from labeled results
- **WHEN** per-task B0 outcomes mark a task as "public pass, private fail"
- **THEN** that task is included in the selected subset

#### Scenario: Exclude non-false-green tasks
- **WHEN** a task's public tests already fail under B0
- **THEN** it is excluded from the false-green subset

### Requirement: Default experimental subset
The system SHALL provide a default subset of tasks 085 through 090 as the initial experiment set.

#### Scenario: Default subset contents
- **WHEN** no explicit task list is supplied
- **THEN** the pipeline uses identifiers for tasks 085, 086, 087, 088, 089, and 090
