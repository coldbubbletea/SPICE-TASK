## Purpose

Provide a one-page web interface where a user can launch PROBE experiments with one click, watch progress live, and inspect per-task patches, probe reports, and scores without using the terminal.

## ADDED Requirements

### Requirement: One-click start
The console SHALL be reachable by a single command (or double-clicking the desktop app) that starts the server and opens the console UI.

#### Scenario: Single command launch
- **WHEN** the user runs the one-click start command or launches the desktop app
- **THEN** a local web server is running and the console UI opens automatically

### Requirement: Core repair flow
The console SHALL present the repair workflow as one guided sequence: pick workspace → configure API → describe bug → start. All four inputs SHALL be visible in a single panel, and the Start button SHALL be disabled until workspace and API config are valid and a bug description is non-empty.

#### Scenario: Single command launch
- **WHEN** the user runs the one-click start command
- **THEN** a local web server is running and the browser opens the console overview page

### Requirement: Overview dashboard
The overview page SHALL show, for each available baseline (B0/B1/B2) and task, the resolved status and public/private pass counts in a scannable grid.

#### Scenario: Dashboard renders results
- **WHEN** at least one run has completed results
- **THEN** the overview shows one row per (baseline, task) with resolved flag and pass counts

### Requirement: Run launcher
The console SHALL let the user start work with one click in either mode: (a) benchmark mode — select baselines and tasks; or (b) ad-hoc mode — select a local workspace, enter a bug description, and optionally attach test commands.

#### Scenario: Launch a benchmark run
- **WHEN** the user selects baseline B2 and task 086 and clicks start
- **THEN** a new run is created and its live status appears in the console

#### Scenario: Launch an ad-hoc repair
- **WHEN** the user picks a workspace directory, saves a valid API config, writes a bug description, and clicks start
- **THEN** an ad-hoc repair job is created and its live status appears in the console

#### Scenario: Start disabled until ready
- **WHEN** the bug description is empty or the API config has not passed a connectivity check
- **THEN** the Start button is disabled with an inline hint naming what is missing

### Requirement: Live progress
While a run is active, the console SHALL update per-task stage (probing / repairing / scoring / done) without requiring a manual page reload.

#### Scenario: Stage updates
- **WHEN** a running task advances from probing to repairing
- **THEN** the console reflects the new stage within a few seconds

### Requirement: Task detail view
Selecting a task SHALL show its problem statement, produced patch, probe report (for B2), and per-group test scores.

#### Scenario: Inspect a completed task
- **WHEN** the user opens a completed task's detail
- **THEN** the page shows the patch text, public/private counts, and resolved flag
