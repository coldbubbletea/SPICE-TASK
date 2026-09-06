"""Ingest existing SWE-bench Science job artifacts into the result store."""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any


def scan_jobs_root(jobs_root: Path) -> list[dict[str, Any]]:
    """Scan a jobs directory for completed trials and return result records."""
    results: list[dict[str, Any]] = []
    if not jobs_root.is_dir():
        return results

    baseline_label = jobs_root.name

    for trial_dir in sorted(jobs_root.iterdir()):
        if not trial_dir.is_dir():
            continue
        reward_path = trial_dir / "verifier" / "reward.json"
        result_path = trial_dir / "result.json"
        if not reward_path.is_file() or not result_path.is_file():
            continue

        try:
            reward = json.loads(reward_path.read_text())
            result = json.loads(result_path.read_text())
        except (json.JSONDecodeError, OSError):
            continue

        task_id = reward.get("task_id", trial_dir.name.split("__")[0])
        public = reward.get("public", {})
        private = reward.get("private", {})
        resolved = bool(reward.get("reward", 0) == 1)

        patch_path = trial_dir / "artifacts" / "model.patch"
        patch_text = ""
        if patch_path.is_file():
            try:
                patch_text = patch_path.read_text()
            except OSError:
                pass

        results.append({
            "task_id": task_id,
            "baseline": baseline_label,
            "trial_name": result.get("trial_name", trial_dir.name),
            "resolved": resolved,
            "public_passed": public.get("passed", 0),
            "public_total": public.get("collected", 0),
            "private_passed": private.get("passed", 0),
            "private_total": private.get("collected", 0),
            "reward": reward.get("reward", 0),
            "patch": patch_text,
            "ingested_at": time.time(),
        })

    return results


def ingest_roots(roots: list[Path]) -> list[dict[str, Any]]:
    """Ingest from multiple jobs roots, deduplicate by (baseline, task_id)."""
    seen: set[tuple[str, str]] = set()
    all_results: list[dict[str, Any]] = []
    for root in roots:
        for record in scan_jobs_root(root):
            key = (record["baseline"], record["task_id"])
            if key not in seen:
                seen.add(key)
                all_results.append(record)
    return all_results


def persist(ingested: list[dict[str, Any]], out_path: Path) -> None:
    """Write ingested results to a JSON file for the frontend."""
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(json.dumps(ingested, indent=2))


def load(out_path: Path) -> list[dict[str, Any]]:
    """Load previously persisted ingested results."""
    if not out_path.is_file():
        return []
    try:
        return json.loads(out_path.read_text())
    except (json.JSONDecodeError, OSError):
        return []
