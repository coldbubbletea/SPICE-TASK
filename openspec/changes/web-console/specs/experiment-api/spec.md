## Purpose

Expose PROBE experiment control and result queries as a small JSON API so the console (and scripts) can start runs, poll status, and fetch artifacts.

## ADDED Requirements

### Requirement: Launch endpoint
The API SHALL accept a request naming baselines and task ids, create a run, and return a run id immediately while execution proceeds in the background.

#### Scenario: Create run
- **WHEN** a POST names baseline `b2_probe` and tasks `["task_086"]`
- **THEN** it returns a run id and status `running` without blocking on completion

#### Scenario: Reject unknown baseline
- **WHEN** a request names an undefined baseline
- **THEN** the API returns an error naming the unknown id and creates no run

### Requirement: Status endpoint
The API SHALL report, for a run, each task's current stage and final result once available.

#### Scenario: Poll a running run
- **WHEN** a client requests status for an active run
- **THEN** it receives per-task stage values (e.g. `probing`, `repairing`, `scoring`, `done`)

### Requirement: API configuration endpoints
The API SHALL expose GET/PUT for the user's LLM endpoint configuration (base URL, API key, model) and a POST endpoint that tests connectivity with a minimal chat request.

#### Scenario: Save and read config
- **WHEN** a client PUTs a config with base URL, key, and model
- **THEN** subsequent GET returns the same values

#### Scenario: Connectivity test
- **WHEN** a client POSTs to the connection-test endpoint
- **THEN** it receives `{ok: true}` on success or `{ok: false, error: "..."}` on failure without creating any job

### Requirement: Artifact endpoint
The API SHALL serve a task's patch, probe report, and score record by run id and task id.

#### Scenario: Fetch artifacts
- **WHEN** a client requests artifacts for a completed task
- **THEN** it receives the patch text, probe report (if any), and the machine-readable score record
