# PROBE 项目 — 会话上下文 (2026-09-06)

> **给下一个 session 的 agent**: 读完这个文件 + `/home/satoru/swe-shunyu/notes.md` 即可接上所有工作。

---

## 当前状态（2026-09-06 第二轮）

用户要搭 PROBE，决定用 **OpenSpec** (Fission-AI) scaffold。**已完成 OpenSpec 接入 + 首个 change 规划**。

### 本轮完成
- [x] 装好 OpenSpec CLI：`@fission-ai/openspec@1.12.0`（系统 Node 是 v18，OpenSpec 需 ≥20；用临时 **Node v22** 装的）
    - Node v22 解压在 `/tmp/node-v22.23.2-linux-x64/`（/tmp 可能被清，重装见下）
    - openspec 装在用户 npm prefix：`/home/satoru/.npm-global/bin/openspec`
- [x] `openspec init` 成功创建核心结构 `openspec/{config.yaml, specs/, changes/}`（doctor: ok）
- [x] 建了首个 change **`probe-foundation`**，4/4 artifacts 完成且 `openspec validate` 通过：
    - `proposal.md` / `design.md` / `tasks.md`
    - 5 个 capability specs：`task-loading`, `invariant-probing`, `repair-agent`, `experiment-pipeline`, `evaluation-scoring`
- [ ] **未完成**：Codex skill 安装（`openspec init --tools codex` 的 `.agents/skills` 那步）在本沙箱失败 —— `.agents`/`.codex`/`.git` 是**只读 mountpoint**。不影响规划；只影响 `/opsx:` 自然语言调用。在普通终端跑一次即可补上（见下）。

### 复现命令（如需重装 / 换机器）
```bash
# Node ≥20（本机 v18，临时用 v22）
cd /tmp && curl -sS -O https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz \
  && tar xf node-v22.23.2-linux-x64.tar.xz
export PATH=/tmp/node-v22.23.2-linux-x64/bin:$PATH
npm install -g @fission-ai/openspec@latest   # → ~/.npm-global/bin/openspec
cd /home/satoru/probe && openspec init --tools codex --language en --profile core
```

### 下一步（用户明确要求的，按优先级）
1. **教 VS Code + Codex 用 OpenSpec** —— 本轮已口头讲解；若要在本仓库真正启用 `/opsx:` skill，需在**非沙箱终端**跑 `openspec init --tools codex`（写 `.agents/skills/`），然后重开 Codex。
2. **实现 PROBE Python 包**：按 `openspec/changes/probe-foundation/tasks.md` 的 8 组任务落地代码（`probe/`, `configs/`, `scripts/`, `tests/`）。
3. notes.md Part G 待办：087 验证、扩子集、Agent A prompt、跑 B1/B2。

---

## PROBE 是什么（一句话）

Two-agent automated program repair for scientific code:
- **Agent A (Invariant Prober)**: 先对代码库生成不变量探针/额外测试，暴露 "同一 bug class 多个入口" 的问题
- **Agent B (Repair Agent)**: 拿着 Agent A 的探针结果做修复
- **核心假设**: 单 agent 只修它看到的那条路径；PROBE 通过对抗性探针让多条路径都暴露

### Baselines
| ID | 说明 | 状态 |
|----|------|------|
| B0 | Vanilla single-agent (codex+deepseek-v4-pro) | ✅ 已有: 0/6 |
| B1 | Single-agent + "generate more tests" prompt | 待跑 |
| B2 | PROBE two-agent (A→B) | 待跑 |

### 实验子集
SWE-bench Science tasks 085-090（6 题），特征: "public 过 / private 挂"（假绿灯）

---

## OpenSpec 用法速查（VS Code + Codex）

OpenSpec = spec-driven 工作流。核心目录 `openspec/`：
- `openspec/specs/<capability>/spec.md` — 已归档的能力规格（系统"应做什么"的行为契约）
- `openspec/changes/<change-id>/` — 一个 change 的规划包：`proposal.md`(why) + `specs/**`(delta) + `design.md`(how) + `tasks.md`(checklist)

工作流循环：**explore → propose → apply → archive**
1. `/opsx:propose <idea>` — AI 生成 change 规划（proposal/specs/design/tasks），人工 review
2. `/opsx:apply` — 按 tasks.md 逐条实现代码，打勾
3. `openspec validate <change-id>` — 校验格式
4. `/opsx:archive` — 归档：delta specs 合并进 `openspec/specs/`，change 移入 `changes/archive/`

**Codex 调用方式**：OpenSpec 把 workflow 装成 skill（`.agents/skills/opsx-*.md`）。在 VS Code Codex prompt 框里用自然语言即可触发，例如：
- "propose: add the invariant prober" → 走 propose
- "apply probe-foundation" → 实现该 change
- （Codex 的 slash 形式是 `$opsx-propose`；CLI 侧用 `openspec <cmd>`）

**关键 CLI**：`openspec init` / `list` / `status --change X` / `show X` / `validate X` / `new change <id>` / `archive X` / `doctor`。
（本沙箱跑 openspec 要带 PATH：`export PATH=/home/satoru/.npm-global/bin:/tmp/node-v22.23.2-linux-x64/bin:$PATH`）

---

## 关键文件位置

| 文件 | 路径 |
|------|------|
| 完整研究笔记 | `/home/satoru/swe-shunyu/notes.md` |
| 086 详细报告 | `/home/satoru/swe-shunyu/report_task_086.md` |
| 086 patch (verified) | `/home/satoru/swe-shunyu/task_086.patch` |
| 087 patch (待验证) | `/home/satoru/swe-shunyu/task_087.patch` |
| SWE-bench Science 数据 | `/home/satoru/swe-bench-science/` |
| PROBE 项目 (本目录) | `/home/satoru/probe/` |
| OpenSpec 规划 | `/home/satoru/probe/openspec/` |

---

## 环境信息

- **Model**: Qwen3.8-27B via Unsloth Studio (local, `http://127.0.0.1:8888/v1`)
- **系统 Node**: v18（不够）；**OpenSpec 用临时 Node v22**（见复现命令）
- **Sandbox**: workspace-write；`.agents`/`.codex`/`.git` 为只读 mountpoint（Codex skill 安装需非沙箱终端）
- **工作目录**: `/home/satoru/probe`
- **用户语言**: 中文为主，技术术语英文

---

## 已讨论但未执行的设计（Python 包，见 tasks.md）

```
probe/
├── README.md, requirements.txt, .gitignore
├── probe/
│   ├── pipeline.py          # B0/B1/B2 orchestrator
│   ├── prober.py            # Agent A: Invariant Prober
│   ├── repairer.py          # Agent B (B0 vanilla / B1 testgen)
│   ├── agent_runner.py      # LLM client for local endpoint + preflight
│   ├── evaluation/scorer.py # F2P/P2P + resolved flag
│   ├── data/task_loader.py  # SWE-bench Science loader + false-green subset
│   └── prompts/{prober,repairer,baseline_testgen}.md
├── configs/{b0_vanilla,b1_testgen,b2_probe}.yaml
├── scripts/{run_experiment,run_single_task}.py
├── results/
└── tests/test_scorer.py
```

---

## 用户风格偏好

- 简洁直接，中文为主
- 喜欢 emoji 点缀（🐦💪）
- 论文目标: 4 页 report (Motivation → RQ+Method → Setup → Results → Limitations)
- 项目代号: **PROBE**（不是 PRISM）
