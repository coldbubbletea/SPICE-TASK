"""Job registry: create, track, and persist experiment/ad-hoc jobs."""
from __future__ import annotations

import json
import time
import uuid
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any


class Stage(str, Enum):
    PENDING = "pending"
    PROBING = "probing"
    REPAIRING = "repairing"
    SCORING = "scoring"
    DONE = "done"
    FAILED = "failed"
    INTERRUPTED = "interrupted"


@dataclass
class TaskState:
    task_id: str
    stage: Stage = Stage.PENDING
    result: dict[str, Any] | None = None
    error: str | None = None

    def to_dict(self) -> dict:
        return {
            "task_id": self.task_id,
            "stage": self.stage.value,
            "result": self.result,
            "error": self.error,
        }


@dataclass
class Job:
    id: str
    mode: str  # "benchmark" | "adhoc"
    baseline: str
    tasks: list[str]
    created_at: float = field(default_factory=time.time)
    status: str = "running"  # running | completed | failed
    task_states: dict[str, TaskState] = field(default_factory=dict)
    workspace: str | None = None
    bug_description: str | None = None

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "mode": self.mode,
            "baseline": self.baseline,
            "tasks": self.tasks,
            "created_at": self.created_at,
            "status": self.status,
            "workspace": self.workspace,
            "bug_description": self.bug_description,
            "task_states": {k: v.to_dict() for k, v in self.task_states.items()},
        }

    @classmethod
    def from_dict(cls, d: dict) -> Job:
        job = cls(
            id=d["id"],
            mode=d["mode"],
            baseline=d["baseline"],
            tasks=d["tasks"],
            created_at=d.get("created_at", time.time()),
            status=d.get("status", "running"),
            workspace=d.get("workspace"),
            bug_description=d.get("bug_description"),
        )
        for tid, ts in d.get("task_states", {}).items():
            job.task_states[tid] = TaskState(
                task_id=ts["task_id"],
                stage=Stage(ts.get("stage", "pending")),
                result=ts.get("result"),
                error=ts.get("error"),
            )
        return job


class JobRegistry:
    """In-memory job store with JSON persistence under results/jobs/."""

    def __init__(self, root: Path):
        self.root = root / "jobs"
        self.root.mkdir(parents=True, exist_ok=True)
        self.jobs: dict[str, Job] = {}
        self._load()

    def _load(self) -> None:
        for path in sorted(self.root.glob("*.json")):
            try:
                job = Job.from_dict(json.loads(path.read_text()))
                if job.status == "running":
                    job.status = "interrupted"
                    self._save(job)
                self.jobs[job.id] = job
            except (json.JSONDecodeError, KeyError):
                continue

    def _save(self, job: Job) -> None:
        path = self.root / f"{job.id}.json"
        path.write_text(json.dumps(job.to_dict(), indent=2))

    def create(
        self,
        mode: str,
        baseline: str,
        tasks: list[str],
        workspace: str | None = None,
        bug_description: str | None = None,
    ) -> Job:
        job_id = f"{int(time.time())}-{uuid.uuid4().hex[:6]}"
        job = Job(
            id=job_id,
            mode=mode,
            baseline=baseline,
            tasks=tasks,
            workspace=workspace,
            bug_description=bug_description,
        )
        for tid in tasks:
            job.task_states[tid] = TaskState(task_id=tid)
        self.jobs[job_id] = job
        self._save(job)
        return job

    def get(self, job_id: str) -> Job | None:
        return self.jobs.get(job_id)

    def list(self) -> list[Job]:
        return sorted(self.jobs.values(), key=lambda j: j.created_at, reverse=True)

    def set_stage(self, job_id: str, task_id: str, stage: Stage) -> None:
        job = self.jobs.get(job_id)
        if not job:
            return
        if task_id in job.task_states:
            job.task_states[task_id].stage = stage
        else:
            job.task_states[task_id] = TaskState(task_id=task_id, stage=stage)
        self._save(job)

    def set_result(self, job_id: str, task_id: str, result: dict) -> None:
        job = self.jobs.get(job_id)
        if not job:
            return
        ts = job.task_states.get(task_id)
        if ts:
            ts.result = result
            ts.stage = Stage.DONE
        self._save(job)

    def set_error(self, job_id: str, task_id: str, error: str) -> None:
        job = self.jobs.get(job_id)
        if not job:
            return
        ts = job.task_states.get(task_id)
        if ts:
            ts.error = error
            ts.stage = Stage.FAILED
        self._save(job)

    def mark_done(self, job_id: str) -> None:
        job = self.jobs.get(job_id)
        if not job:
            return
        if any(ts.stage == Stage.FAILED for ts in job.task_states.values()):
            job.status = "failed"
        else:
            job.status = "completed"
        self._save(job)
