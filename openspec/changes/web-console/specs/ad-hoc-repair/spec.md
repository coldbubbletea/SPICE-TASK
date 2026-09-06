## Purpose

Let a user repair their own local code from a bug description: select a workspace directory, describe the bug, optionally supply test commands, and receive a patch with before/after verification — without any benchmark data.

## ADDED Requirements

### Requirement: API configuration
The system SHALL let the user configure the LLM endpoint (base URL, API key, model name) per repair session, persist it locally, and validate connectivity with a test request before starting a job.

#### Scenario: Save API config
- **WHEN** the user enters a base URL, API key, and model name and saves
- **THEN** the configuration is persisted locally and used as the default for subsequent jobs

#### Scenario: Connectivity check
- **WHEN** the user clicks "test connection"
- **THEN** the system sends a minimal chat request to the configured endpoint and reports success or the error message

### Requirement: Workspace selection
The system SHALL let the user pick a local directory as the target workspace through a file picker dialog, validate that it exists and is readable before accepting a repair job, and display its name in the launch panel.

#### Scenario: Valid workspace
- **WHEN** the user submits an existing directory path as workspace
- **THEN** the job is accepted and a sandboxed copy of the workspace is created for modification

#### Scenario: Invalid workspace
- **WHEN** the user submits a path that does not exist or is not a directory
- **THEN** the job is rejected with a clear error and nothing is modified

### Requirement: Bug description input
The system SHALL require a free-text bug description as the primary input for an ad-hoc repair job.

#### Scenario: Description drives probing
- **WHEN** an ad-hoc job runs
- **THEN** Agent A generates invariant probes from the bug description and the workspace contents, not from benchmark task data

### Requirement: Optional user tests
The system SHALL allow the user to attach their own test commands or test files that are executed before and after repair.

#### Scenario: Before/after comparison
- **WHEN** a job includes user test commands
- **THEN** results report both the pre-repair and post-repair outcomes of those commands

### Requirement: Patch delivery
On completion, the system SHALL provide the produced patch as a downloadable diff and keep the original workspace untouched.

#### Scenario: Downloadable patch
- **WHEN** an ad-hoc job finishes
- **THEN** the user can download a unified diff of all changes made in the sandbox copy
