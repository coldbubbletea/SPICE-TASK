# PROBE 项目 — 会话上下文 (2026-09-06, 第三轮更新)

> **给下一个 session 的 agent**: 读完本文件 + `COMMUNICATION_LOG.md`（完整沟通记录）+ `/home/satoru/swe-shunyu/notes.md`（研究笔记）即可接上全部工作。
> 所有规划在 `openspec/changes/`，用 `openspec validate <change>` / `openspec status --change <change>` 查看状态。

---

## ⚡ 当前进行中的事（重启后第一件事）

**正在 apply `web-console` change**。下一步 = task 1.4：实现 LLM config 端点
（GET/PUT `/api/config` → 持久化到 `results/config.json`；POST `/api/config/test` → 最小 chat-completion 连通性测试）。
完成后按 tasks.md 顺序继续：前端 React+TS+Vite（Repair panel hero）→ ad-hoc 接线 → desktop 壳 + CI → 截图 QA。

## 已完成（本轮）

- [x] OpenSpec 接入：CLI v1.12.0（Node v22 临时装在 `/tmp/node-v22.23.2-linux-x64/`，openspec 在 `~/.npm-global/bin/`）
- [x] Codex skills 装好（用户在自己终端跑的 `openspec init --tools codex`，6 个 skill 在 `.agents/skills/`）
- [x] GitHub: **私有仓库** `coldbubbletea/PROBE-Proactive-Repair-via-Orchestrated-Boundary-Enumeration`，首 commit `2f5ddbd` 已 push。remote 是干净 URL（token 未落盘）。
- [x] Change `probe-foundation`: 4/4 artifacts, 19 tasks, validate ✓（PROBE 核心设计，尚未 apply）
- [x] Change `web-console`: 4/4 artifacts, ~22 tasks, validate ✓（本轮多次 spec 迭代，见下）
- [x] Web 后端: `probe/web/{server,registry,ingest}.py` + `scripts/run_console.py`
- [x] Ingestion 验证通过: 真实 B0 数据 6 条（task_085-090, codex+deepseek-v4pro）
- [x] 临时占位前端 `probe/web/static/index.html`（深色 dashboard，展示真实 B0 数据）
- [ ] **web-console task 1.4**: LLM config 端点 ← **从这里继续**

## web-console spec 迭代历史（用户逐步明确的需求）

1. 漂亮前端 + 一键使用
2. + ad-hoc: 用户选 workspace + 输入 bug 描述 → 自动修复
3. + 跨平台客户端，开袋即用（Linux+Windows）→ pywebview + PyInstaller + GH Actions matrix
4. 前端栈: "世界最流行的生态和栈" → **React 18 + TypeScript + Vite**
5. + **用户自配 API**（base URL / key / model，连通性测试），核心 UX = 选 workspace → 配 API → 描述 bug → Start（单面板引导式，未就绪禁用 Start）

## ⚠️ 环境约束（必须知道，否则会踩坑）

| 约束 | 影响 |
|------|------|
| **沙箱禁止创建任何 socket** | 活服务器/截图 QA 必须 `require_escalated` 提权在沙箱外跑；TestClient（ASGI 内存传输）可在沙箱内测 API |
| `.agents` / `.codex` / `.git` = 只读 mountpoint | git 写操作、Codex skill 安装必须提权或用户自己终端跑 |
| 沙箱内 DNS/网络全断 | curl 外部资源要提权；**沙箱内也连不上沙箱外起的 localhost 服务**（出站被禁）→ 让用户自己浏览器看 |
| 后台进程随会话结束被杀 | 起持久服务用 `setsid nohup ... < /dev/null &` |
| **pkill 自杀陷阱** | pkill 模式会匹配到自己的命令行 → 用 `[x]` 技巧（如 `pkill -f 'uvicorn [p]robe'`）或干脆不 pkill，先 `curl health` 探测 |
| Node v22 在 /tmp（临时目录，可能被清） | openspec 命令要带 PATH: `export PATH=/home/satoru/.npm-global/bin:/tmp/node-v22.23.2-linux-x64/bin:$PATH`；被清了按 COMMUNICATION_LOG §2 重装 |
| Python = anaconda3 (3.13) | requests/yaml/pytest/fastapi/uvicorn 已装；webview/PySide6 未装（desktop 壳阶段要 `pip install pywebview pyinstaller`） |

## 当前运行中的服务

- PROBE console: `http://127.0.0.1:8765`（setsid 持久，沙箱外可见；重启机器后需重起:
  `cd /home/satoru/probe && PROBE_RESULTS=$PWD/results setsid nohup python3 -m uvicorn probe.web.server:app --host 127.0.0.1 --port 8765 > /tmp/probe_server.log 2>&1 < /dev/null &`）

## 文件地图

```
/home/satoru/probe/                     # git repo (private, origin=GitHub)
├── SESSION_CONTEXT.md                  # 本文件
├── COMMUNICATION_LOG.md                # 完整沟通记录（决策+坑）
├── openspec/                           # OpenSpec 规划
│   ├── config.yaml
│   └── changes/
│       ├── probe-foundation/           # PROBE 核心 (未 apply)
│       └── web-console/                # Web 控制台 (apply 中, task 1.4 起)
├── probe/
│   ├── __init__.py
│   ├── data/ evaluation/ prompts/      # 空目录，probe-foundation apply 时填
│   └── web/
│       ├── server.py                   # FastAPI app (已验证: health/results/jobs)
│       ├── registry.py                 # JobRegistry, JSON 持久化 results/jobs/
│       ├── ingest.py                   # 扫 jobs root → reward.json/result.json/model.patch
│       └── static/index.html           # 临时占位前端（React 版会替换）
├── scripts/run_console.py              # 一键启动 (uvicorn + open browser)
├── results/                            # .gitignored; jobs/, ingested/
├── configs/ tests/                     # 空，待填
└── .agents/skills/                     # OpenSpec Codex skills (6 个)

外部数据:
/home/satoru/swe-bench-science/jobs/    # B0 历史 jobs (20 roots, 50M) — ingestion 源
/home/satoru/swe-shunyu/notes.md        # 研究笔记 (PROBE 设计、086/087 案例)
```

## 技术栈（最终确认，用户拍板）

| 层 | 选型 |
|----|------|
| Frontend | **React 18 + TypeScript + Vite**（"世界最流行的生态和栈"） |
| Backend | FastAPI + uvicorn (Python 3.13) |
| Desktop | pywebview + PyInstaller → zip 开袋即用 (Win amd64 + Linux x86_64) |
| CI | GitHub Actions matrix |
| LLM | **用户自配 API**（默认建议本地 Qwen3.8-27B @ http://127.0.0.1:8888/v1） |
| Data | SWE-bench Science 085-090 (false-green subset) |

## GitHub token 状态

- 旧 fine-grained token: 无仓库权限，已无用，建议 revoke
- classic token (`ghp_NeDOSo...`): 有效 + push 权限；**只在对话里出现过，未写入任何文件**。push 成功后可 revoke，或保留备用（下次 push 需要时向用户要）

## 用户偏好

- 中文为主，技术术语英文；emoji 点缀（🐦💪）
- **每步都要过 spec**（"必须每一步都通过spec"）——改行为先改 openspec specs 并 validate，再实现
- 选型优先世界主流/生态大小
- 开袋即用 > 开发者友好；研究工具也要产品级 UI
- 回复要简洁直接（但关键决策要讲清理由）
- 论文目标: 4 页 report；console 截图可当 figure
