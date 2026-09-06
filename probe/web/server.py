"""PROBE Web Console — FastAPI application."""
from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .ingest import ingest_roots, load as load_ingested, persist
from .registry import JobRegistry, Stage

RESULTS_DIR = Path(os.environ.get("PROBE_RESULTS", Path(__file__).resolve().parent.parent.parent / "results"))
INGESTED_PATH = RESULTS_DIR / "ingested" / "results.json"
JOBS_ROOTS_ENV = os.environ.get("PROBE_JOBS_ROOTS", "/home/satoru/swe-bench-science/jobs")

app = FastAPI(title="PROBE Console", version="0.1.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

registry = JobRegistry(RESULTS_DIR)


def _jobs_roots() -> list[Path]:
    return [Path(p.strip()) for p in JOBS_ROOTS_ENV.split(os.pathsep) if p.strip()]


# --- Schemas ---
class CreateJobRequest(BaseModel):
    mode: str  # "benchmark" | "adhoc"
    baseline: str
    tasks: list[str] = []
    workspace: str | None = None
    bug_description: str | None = None


# --- Routes ---
@app.get("/api/health")
def health() -> dict:
    return {"status": "ok", "version": app.version}


@app.get("/api/results")
def get_results() -> list[dict[str, Any]]:
    """Return ingested historical results (B0 etc.)."""
    records = load_ingested(INGESTED_PATH)
    if not records:
        records = ingest_roots(_jobs_roots())
        persist(records, INGESTED_PATH)
    return records


@app.post("/api/results/refresh")
def refresh_results() -> dict:
    """Re-scan jobs roots and update the ingested store."""
    records = ingest_roots(_jobs_roots())
    persist(records, INGESTED_PATH)
    return {"count": len(records)}


@app.post("/api/jobs", status_code=201)
def create_job(req: CreateJobRequest) -> dict:
    """Create a new experiment or ad-hoc repair job."""
    valid_baselines = {"b0_vanilla", "b1_testgen", "b2_probe"}
    if req.baseline not in valid_baselines:
        raise HTTPException(400, f"Unknown baseline '{req.baseline}'. Valid: {sorted(valid_baselines)}")

    if req.mode == "benchmark":
        if not req.tasks:
            raise HTTPException(400, "Benchmark mode requires at least one task id")
    elif req.mode == "adhoc":
        if not req.workspace or not Path(req.workspace).is_dir():
            raise HTTPException(400, f"Workspace '{req.workspace}' does not exist or is not a directory")
        if not req.bug_description:
            raise HTTPException(400, "Ad-hoc mode requires a bug description")
    else:
        raise HTTPException(400, f"Unknown mode '{req.mode}'. Use 'benchmark' or 'adhoc'")

    job = registry.create(
        mode=req.mode,
        baseline=req.baseline,
        tasks=req.tasks or ["adhoc"],
        workspace=req.workspace,
        bug_description=req.bug_description,
    )
    # In a full implementation, this would launch the pipeline in a background thread.
    # For now, mark as pending — the frontend polls and shows status.
    return job.to_dict()


@app.get("/api/jobs")
def list_jobs() -> list[dict]:
    """List all jobs (newest first)."""
    return [j.to_dict() for j in registry.list()]


@app.get("/api/jobs/{job_id}")
def get_job(job_id: str) -> dict:
    """Get a single job with per-task stages."""
    job = registry.get(job_id)
    if not job:
        raise HTTPException(404, f"Job '{job_id}' not found")
    return job.to_dict()


@app.get("/api/jobs/{job_id}/tasks/{task_id}/artifacts")
def get_artifacts(job_id: str, task_id: str) -> dict:
    """Get patch, probe report, and score for a completed task."""
    job = registry.get(job_id)
    if not job:
        raise HTTPException(404, f"Job '{job_id}' not found")
    ts = job.task_states.get(task_id)
    if not ts:
        raise HTTPException(404, f"Task '{task_id}' not in job '{job_id}'")
    return {
        "task_id": task_id,
        "stage": ts.stage.value,
        "result": ts.result,
        "error": ts.error,
    }


# --- Static frontend (served after Vite build) ---
STATIC_DIR = Path(__file__).resolve().parent / "static"
if STATIC_DIR.is_dir():
    app.mount("/", StaticFiles(directory=str(STATIC_DIR), html=True), name="static")
