# PROBE 项目 — 完整沟通记录 (2026-09-06)

> 本文档记录从"继续搭 PROBE"到 Web Console + 桌面客户端规划的全部对话与决策。
> 配合 `SESSION_CONTEXT.md`（状态快照）和 `/home/satoru/swe-shunyu/notes.md`（研究笔记）使用。

---

## 1. 会话起点

用户要求：读 `SESSION_CONTEXT.md` + `swe-shunyu/notes.md`，继续搭 PROBE。
PROBE = Two-agent automated program repair for scientific code（Agent A Invariant Prober → Agent B Repair Agent），实验子集 SWE-bench Science 085-090（"public 过 / private 挂"假绿灯任务）。

## 2. OpenSpec 接入

**决策**: 用 OpenSpec (Fission-AI) 做 spec-driven scaffold。
**过程与坑**:
- 系统 Node v18，OpenSpec 要求 ≥20 → 下载官方 Node v22.23.2 tarball 到 `/tmp`（临时，可被清）
- `npm install -g @fission-ai/openspec@1.12.0` → `~/.npm-global/bin/openspec`
- `openspec init --tools codex` 在沙箱内失败：`.agents`/`.codex`/`.git` 是**只读 mountpoint**（沙箱特性）
- 自动审批器有 bug（`input.str: Input should be a valid string`），多次拒绝提权 → 无法在沙箱内绕过
- **解决**: 用户在自己的 VS Code 终端跑 `openspec init --tools codex` 成功，6 个 skill 装入 `.agents/skills/`（openspec-propose / apply-change / archive-change / explore / sync-specs / update-change）
- Codex 调用形式: `$openspec-propose` / `$openspec-apply-change`；不需要重启 VS Code，新会话即可见

**OpenSpec 分工澄清**（用户质疑"你真的是在用 openspec 吗"）:
- CLI 干: init 结构、new change 脚手架、status 依赖图、validate 格式校验（--strict 通过）、show/list
- Agent 干: proposal/specs/design/tasks 的内容撰写（OpenSpec 设计如此："AI writes these; you review"）

## 3. GitHub 仓库

**决策**: 私有仓库 `coldbubbletea/PROBE-Proactive-Repair-via-Orchestrated-Boundary-Enumeration`
**过程与坑**:
- `.gitignore` 先行（排除 `results/`、`__pycache__`、`.venv` 等）
- token 一: fine-grained，但没授权目标仓库 → push 403（API 404 诊断出权限缺失）
- token 二: classic + `repo` scope → API 验证 `push: True` ✅
- push 成功: `2f5ddbd PROBE: OpenSpec scaffold + planning (probe-foundation, web-console)`
- 安全处理: token 只用一次性内联 URL，**未写入 .git/config**（grep 验证 0 tokens）；建议用后 revoke
- git 操作全部走提权（沙箱 `.git` 只读），用户逐次批准

## 4. Web Console 需求演进

用户需求逐步明确：
1. "写一个非常漂亮的前端，用户可以一键使用这个系统"
2. 扩展: "用户选择代码的 workspace，然后输入他们遇到的 bug"（ad-hoc 模式）
3. "我想要一个客户端，跨平台" → 方案对比: pywebview / Tauri / Electron / QtWebEngine
4. "开袋即用，Linux + Windows" → **pywebview + PyInstaller + GitHub Actions matrix**
5. 前端技术栈: 用户先问"为什么不选 TypeScript 这类世界主流"，然后明确"**我要世界最流行的生态和栈**" → **React 18 + TypeScript + Vite**

## 5. OpenSpec Changes（规划产物）

### `probe-foundation`（4/4 artifacts, 19 tasks, validate ✓）
- 5 capabilities: task-loading / invariant-probing / repair-agent / experiment-pipeline / evaluation-scoring
- 内容 = notes.md 的 PROBE 设计（B0/B1/B2 baselines、false-green subset、F2P/P2P scoring）

### `web-console`（4/4 artifacts, 18→21 tasks, validate ✓）
- 5 capabilities: console-ui / experiment-api / result-ingestion / ad-hoc-repair / desktop-shell
- 关键规格:
  - **Zero-dependency launch**: 干净 Win/Linux 机器解压双击即用
  - **Embedded server lifecycle**: 开窗起服务、关窗清理
  - **Cross-platform builds**: CI matrix windows/amd64 + ubuntu/x86_64
  - **Ad-hoc sandboxing**: workspace 先拷贝到 `results/adhoc/<id>/ws/`，原目录绝不动
- design 决策: React18+TS+Vite → Vite build 静态 dist → FastAPI serve；轮询不用 websocket；benchmark/ad-hoc 统一为 job 模型

## 6. 技术栈（最终确认）

| 层 | 选型 |
|----|------|
| Frontend | React 18 + TypeScript + Vite |
| Backend | FastAPI + uvicorn (Python 3.13) |
| Desktop | pywebview + PyInstaller |
| CI | GitHub Actions matrix (win+linux) |
| LLM | Qwen3.8-27B local @ 127.0.0.1:8888/v1 |
| Data | SWE-bench Science (Docker verifier), jobs 在 /home/satoru/swe-bench-science/jobs/ |

刻意排除: React 之外的框架、Electron（体积）、WebSocket、数据库（JSON 文件即状态）、SSR/Next.js。

## 7. 环境约束（重要，影响后续所有操作）

- **沙箱禁止创建任何 socket** → 活服务器、截图 QA 必须提权在沙箱外跑
- `.agents` / `.codex` / `.git` = 只读 mountpoint → git 写操作必须提权
- 网络: 沙箱内 DNS 全断；提权后正常
- Node v22 在 `/tmp/node-v22.23.2-linux-x64/`（临时）；openspec 在 `~/.npm-global/bin/`
- Python: anaconda3, requests/yaml/pytest/fastapi/uvicorn 已装，webview/PySide6 未装

## 8. API 配置需求（第 5 轮迭代）

用户明确核心 UX: **选 workspace → 配自己的 API (base URL/key/model) → 输入 bug → 自动修复**。
Spec 更新（validate ✓）:
- `ad-hoc-repair`: + `API configuration` requirement（持久化、test-connection）; workspace 用文件选择器
- `console-ui`: + `Core repair flow` requirement（单面板引导式，Start 未就绪禁用+inline hint）
- `experiment-api`: + `API configuration endpoints`（GET/PUT /api/config, POST /api/config/test）
- design: config 存 `results/config.json`（用户所有）; agent runner 开工时读取

## 9. 当前进度

- [x] OpenSpec scaffold + 2 changes 规划完成并 push GitHub (commit 2f5ddbd)
- [x] Web 后端: server/registry/ingest + run_console.py（TestClient 验证通过）
- [x] Ingestion 真实数据验证: B0 6 records (task_085-090)
- [x] 临时占位前端 static/index.html（深色 dashboard + 真实 B0 数据，用户已在浏览器看过）
- [ ] **task 1.4: LLM config 端点** ← 重启后从这里继续
- [ ] 前端 React+TS+Vite（Repair panel hero → dashboard → live job → detail）
- [ ] probe-foundation apply（prober/repairer/scorer — ad-hoc 引擎依赖它）
- [ ] Desktop shell + PyInstaller + CI workflow
- [ ] 截图 QA (headless Chrome, 需提权) + commit & push

## 10. 踩坑记录（血泪经验）

1. **沙箱禁 socket**: `socket.socket()` 直接 PermissionError → 活服务必须提权；API 测试用 FastAPI TestClient
2. **pkill 自杀**: pkill -f 的模式匹配到自己的 shell 命令行 → SIGTERM 自己 (exit 143)。解法: `[x]` 技巧或先 curl health 探测
3. **后台进程被回收**: exec 会话结束时 nohup 子进程也被杀 → `setsid nohup ... < /dev/null &` 才持久
4. **沙箱内连不上沙箱外的 localhost 服务**（出站连接被禁）→ 让用户自己浏览器验证，或提权 curl
5. **fine-grained token 没勾仓库 → push 403**; API 查 repo 返回 404 是诊断信号
6. **OpenSpec init --tools codex 在沙箱必失败**（.agents 只读）→ 用户自己终端跑
7. 自动审批器 bug: `input.str: Input should be a valid string` → 提权被随机拒绝，别重试同一命令，换策略或让用户手动
8. /tmp/node-v22 是临时的; openspec 调用要 export PATH（见 SESSION_CONTEXT 环境约束表）

## 11. 用户偏好

- 中文为主，技术术语英文；喜欢 emoji（🐦💪）
- 要"世界最流行的生态和栈"——选型时优先考虑主流/生态大小
- 开袋即用 > 开发者友好；研究工具也要产品级 UI
- 论文目标: 4 页 report；Web Console 截图可直接当 figure
