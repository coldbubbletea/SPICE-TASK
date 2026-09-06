## 1. Project scaffolding
- [ ] 1.1 Add `requirements.txt`, `.gitignore`, and top-level `README.md` describing PROBE and how to run it
- [ ] 1.2 Create package layout `probe/{__init__.py, pipeline.py, prober.py, repairer.py, agent_runner.py}` and subpackages `evaluation/`, `data/`, `prompts/`
- [ ] 1.3 Add `tests/test_scorer.py` with a minimal scorer unit test

## 2. Task loading (task-loading)
- [ ] 2.1 Implement `probe/data/task_loader.py` to load a SWE-bench Science instance by id (problem statement, repo path, public/private test lists)
- [ ] 2.2 Implement false-green subset selection from B0 outcomes and the default tasks 085–090

## 3. Agent runner + prompts (repair-agent)
- [ ] 3.1 Implement `probe/agent_runner.py` chat/completions client for the local endpoint with a preflight connectivity check
- [ ] 3.2 Add prompt templates `prompts/prober.md`, `prompts/repairer.md`, `prompts/baseline_testgen.md`
- [ ] 3.3 Implement `probe/repairer.py` supporting B0 (vanilla) and B1 (test-generation-guided) modes

## 4. Invariant prober (invariant-probing)
- [ ] 4.1 Implement `probe/prober.py` to generate executable invariant probes from a task
- [ ] 4.2 Emit the structured probe report (probe id, targeted path label, pass/fail on unmodified repo)

## 5. Evaluation & scoring (evaluation-scoring)
- [ ] 5.1 Implement `probe/evaluation/scorer.py` to run public and private tests separately and count passes
- [ ] 5.2 Compute the resolved flag (all public AND private pass) and emit a machine-readable record

## 6. Pipeline & orchestration (experiment-pipeline)
- [ ] 6.1 Implement `probe/pipeline.py` with config-driven baseline selection and fail-fast on unknown ids
- [ ] 6.2 Wire B2 sequencing: run prober to completion, pass its report into repairer
- [ ] 6.3 Add per-task isolation (sandboxed repo copy) and write artifacts under `results/`

## 7. Run scripts & configs
- [ ] 7.1 Add `configs/b0_vanilla.yaml`, `b1_testgen.yaml`, `b2_probe.yaml`
- [ ] 7.2 Add `scripts/run_experiment.py` (full subset) and `scripts/run_single_task.py`

## 8. Verification
- [ ] 8.1 Run scorer unit tests
- [ ] 8.2 Smoke-run B0 on task_086 and confirm a resolved record is written to `results/`
