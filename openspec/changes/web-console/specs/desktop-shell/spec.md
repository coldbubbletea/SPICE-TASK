## Purpose

Deliver PROBE as an out-of-the-box desktop application: users download a per-platform archive, unzip it, and double-click the PROBE app — no Python, Node, or other prerequisites installed.

## ADDED Requirements

### Requirement: Zero-dependency launch
On Windows and Linux, launching the packaged app SHALL require no pre-installed runtime beyond the operating system's default web view component.

#### Scenario: Fresh machine run
- **WHEN** a user unzips the platform archive on a clean Windows or Linux install and runs the PROBE executable
- **THEN** the PROBE window opens with the console UI without any additional installation step

### Requirement: Embedded server lifecycle
The desktop app SHALL start its local API server automatically on launch and stop it when the window closes.

#### Scenario: Window close cleans up
- **WHEN** the user closes the PROBE window
- **THEN** the embedded server process terminates and no orphaned listener remains on the port

### Requirement: Cross-platform builds
The project SHALL provide CI configuration that builds signed-off artifacts for Windows (amd64) and Linux (x86_64) from a single source tree.

#### Scenario: CI matrix build
- **WHEN** a release workflow runs
- **THEN** it produces one runnable archive per target platform attached to the release
