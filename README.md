# SPICE — 面向科学软件的探针—修复智能体系统

SPICE 是一条面向 *SWE-Bench Science* 类科学软件缺陷的三阶段智能体流水线。它要解决的问题是：
科学软件的**私有测试集不可见**，而公开复现脚本常常给出“假绿灯”（public 脚本通过、private
套件仍然失败）。SPICE 的做法是先把隐藏契约显式化成**可执行探针**，再让修复有据可依。

| 阶段 | 智能体 | 做什么 | 主要产物 |
|---|---|---|---|
| 1 | **SciProber** | 只读 bug 描述与仓库代码，反推隐藏契约，产出可执行探针 | `probes/manifest.json`、`probe-report-*.json` |
| 2 | **SciPatcher** | 三通道并行产出候选补丁，各自先跑探针 + public repro 自验 | `patch-r1-{sci,general,ds}.diff`、`comparison-r1.json` |
| 3 | **SciReviewer** | 按 rubric 逐维打分、选优，并在胜出候选上修补打磨 | `patch-r1-mentor-polished.diff`（终审后 apply 到工作区） |

三个阶段的判定都**不读取私有测试**：探针、public repro 与 rubric 是 agent 能看到的全部证据。
私有测试只在最后验收时由 Docker verifier 跑一次，用于报告分数。

---

## 你需要准备什么

| 依赖 | 最低要求 | 本机实测版本 | 检查命令 |
|---|---|---|---|
| Node.js | ≥ 18 | `v18.19.1` | `node -v` |
| Claude Code CLI | 任意近期版本 | `2.1.270` | `claude --version` |
| Codex CLI | 任意近期版本 | `0.153.2` | `codex --version` |
| Docker | 能 `docker run` | `29.7.2` | `docker --version` |
| Git | 任意 | `2.43.0` | `git --version` |
| DeepSeek API key | `sk-...` | — | 见第 1 步 |

> **为什么 claude 和 codex 两个 CLI 都要装**：`swe-bench-sci/023.json` 里 prober 通道
> （`providers.deepseek-flash`）**没有**设 `harness`，所以运行时走 **codex exec 分支**；
> patcher 与 reviewer（`providers.deepseek`，`harness: "claude"`）走 **claude -p 分支**。
> 但 `run_prober.sh` 的 preflight 只校验 `claude`——这是已知的校验盲区，请两个都装好。

> **Windows 用户**：本仓库所有流程脚本都是 `.sh`，PowerShell 不能直接执行，需要先装
> **Git for Windows（自带 Git Bash）** 或 **WSL**。每一节的 PowerShell 写法见下方
> 「[Windows / PowerShell：0 → 023 全流程](#windows--powershell0--023-全流程)」。

---

## 从 0 跑通 task 023（八步）

下面每步都写清四件事：**执行哪个文件** / **bash 命令** / **PowerShell 对照** /
**成功标志与常见失败**。所有 bash 命令都在**仓库根目录**执行。

### 第 0 步 · 环境自检

**执行文件**：无（只是查版本）

**bash**
```bash
node -v && claude --version && codex --version && docker --version
docker info >/dev/null && echo "docker daemon OK"
```

**PowerShell**（对照写法，本机未装 `pwsh`，未实测）
```powershell
node -v; claude --version; codex --version; docker --version
docker info *> $null; if ($?) { "docker daemon OK" }
```

**成功标志**：四个版本号都能打印，且出现 `docker daemon OK`。

**常见失败**
- `command not found: claude` → `npm i -g @anthropic-ai/claude-code`。
- `command not found: codex` → `npm i -g @openai/codex`（或你惯用的安装方式）。
- `docker info` 报 `Cannot connect to the Docker daemon` → 先把 Docker Desktop / `dockerd` 起起来。

### 第 1 步 · 配置 DeepSeek API key

**执行文件**：无（只设环境变量）

`swe-bench-sci/023.json` 已经把 `roles.*.key` 全部置空，**必须走环境变量**。
key 的解析顺序是：`providers.<provider>.envKey` 指定的环境变量（这里就是 `DEEPSEEK_API_KEY`）
优先，其次才是 `roles.<role>.key`。任一角色 key 解析不到，脚本会 fail-fast 拒绝启动。

**bash**
```bash
export DEEPSEEK_API_KEY=sk-你的key
echo "${DEEPSEEK_API_KEY:0:7}..."   # 回显前 7 位，确认已生效
```

**PowerShell**（对照写法，本机未装 `pwsh`，未实测）
```powershell
$env:DEEPSEEK_API_KEY = "sk-你的key"
$env:DEEPSEEK_API_KEY.Substring(0,7) + "..."
```

**成功标志**：打印出 `sk-xxxxx...`。

**常见失败**：key 写在前一个终端窗口 → 每开一个新终端都要重新 `export` / `$env:`。
想持久化可写进 `~/.bashrc`（bash）或 `setx DEEPSEEK_API_KEY "sk-..."`（PowerShell，需重开窗口）。

### 第 2 步 · 物化 task 023 工作区

**执行文件**：`tools/swe-bench-science/materialize-023.sh`

把环境镜像里的 `/app/task_023` 拷到 `swe-bench-sci/workspaces/task-023/`，并打一个 baseline commit。
这一步必须在 SciProber 之前完成，否则 SciProber 会报「工作区缺失」。

**bash**
```bash
bash tools/swe-bench-science/materialize-023.sh
```

**PowerShell**（对照写法，本机未装 `pwsh`，未实测）
```powershell
bash .\tools\swe-bench-science\materialize-023.sh
# 用 WSL 的话：
# wsl bash ./tools/swe-bench-science/materialize-023.sh
```

**成功标志**：最后一行打印 `MATERIALIZED-OK`，且 `swe-bench-sci/workspaces/task-023/.git` 存在。

**常见失败**
- 提示 `工作区部分存在` → 上次物化残留，先 `rm -rf swe-bench-sci/workspaces/task-023` 再重跑。
- 拉取 env 镜像失败 → 需要网络；镜像 tag 见脚本里的 `ENV_IMG` 常量。
- 想重做：`rm -rf swe-bench-sci/workspaces/task-023`（脚本对已含 `.git` 的工作区会直接跳过）。

### 第 3 步 · SciProber：产出探针

**执行文件**：`swe-bench-sci/run_prober.sh`

**bash**（默认后台运行）
```bash
PTM=30 bash swe-bench-sci/run_prober.sh 023
```

想要前台盯进度：
```bash
PTM=30 bash swe-bench-sci/run_prober.sh 023 --fg
```

**PowerShell**（对照写法，本机未装 `pwsh`，未实测）
```powershell
$env:PTM = "30"
bash .\swe-bench-sci\run_prober.sh 023
# 盯日志（代替 tail -f）：
$log = Get-ChildItem .\swe-bench-sci\logs\prober-023-*.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1
Get-Content -Path $log.FullName -Wait -Tail 30
```

> `PTM` 控制探针专家时限（分钟）。`run-dual-075.js` 的默认值是 **15**，而 `023.json` 的
> `timeBudget` 写明本次 023 用 **30 分钟**——**要复现那份配置就得显式 `PTM=30`**，否则你跑的是 15 分钟版本。

**成功标志**：日志中出现 `stage=probe-done`；新 run 目录下有 `probes/manifest.json`。

**产物与日志**
```
swe-bench-sci/logs/run-023-prober.pid                             后台进程 pid
swe-bench-sci/logs/prober-023-<时间戳>.log                         运行日志
swe-bench-sci/workspaces/task-023/.codex-sci-debug/runs/<runId>/
  probes/manifest.json                                            探针清单（后续阶段的门禁依据）
  probes/p1.py … pN.py                                            探针脚本
  probe-report-tester.json                                        探针报告（提问 / 暴露入口 / 探针清单）
  probe-coverage.json                                             覆盖面配额核对结果
```

**PowerShell 取最新 runId**（对照写法，未实测）
```powershell
$run = Get-ChildItem .\swe-bench-sci\workspaces\task-023\.codex-sci-debug\runs |
       Sort-Object LastWriteTime -Descending | Select-Object -First 1
$run.Name
```

**常见失败**
- `⚠ preflight 未通过` 列出原因 → 最常见是「工作区缺失（请先物化）」或 key 没设；照提示补齐即可。
- 日志里 `启动失败` → 会附日志尾部，看具体报错。
- 卡住不动 → 前面加 `--fg` 重跑，或在 log 里 `grep "stage="` 看停在哪。

### 第 4 步 · SciPatcher：产出候选补丁

**执行文件**：`swe-bench-sci/run_patcher.sh`

不传 runId 时会自动复用 `runs/` 下**最新**的 run 目录；该目录必须已经有 prober 产物，否则脚本直接拒启动。

**bash**
```bash
bash swe-bench-sci/run_patcher.sh 023 --only-roles ds --repair-timeout-min 60
```
显式指定 runId（推荐，避免复用错目录）：
```bash
bash swe-bench-sci/run_patcher.sh 023 <runId> --only-roles ds --repair-timeout-min 60
```

**PowerShell**（对照写法，本机未装 `pwsh`，未实测）
```powershell
$runId = (Get-ChildItem .\swe-bench-sci\workspaces\task-023\.codex-sci-debug\runs |
          Sort-Object LastWriteTime -Descending | Select-Object -First 1).Name
bash .\swe-bench-sci\run_patcher.sh 023 $runId --only-roles ds --repair-timeout-min 60
```

**成功标志**：日志中出现 `stage=patcher-done`；run 目录下出现 `patch-r1-ds.diff`。

**产物**
```
<runId>/patch-r1-ds.diff               本流程（ds 通道）的候选补丁
<runId>/patch-r1-sci.diff              其它通道候选（--only-roles ds 时可能为空/跳过）
<runId>/verify-result-r1-ds.json       该候选的探针 + public repro 自验结果
<runId>/comparison-r1.json             候选横向对比
swe-bench-sci/logs/patcher-023-<时间戳>.log
```
**此阶段不会把补丁打进主工作区**，只是把候选落在 run 目录里。

**常见失败**
- `run 目录 … 缺少 prober 产物` → 第 3 步没跑成功，先回去跑 prober。
- `缺少角色配置` / key 不可解析 → 检查 `swe-bench-sci/023.json` 与 `DEEPSEEK_API_KEY`。
- 超时收工 → `--repair-timeout-min 60` 放宽（`0` 表示不限时，慎用）。

### 第 5 步 · SciReviewer：终审与打磨

**执行文件**：`swe-bench-sci/run_mentor.sh`

**bash**
```bash
bash swe-bench-sci/run_mentor.sh 023 <runId>
```
（脚本文件名沿用历史的 `mentor` 字样，指的就是 SciReviewer。）

**PowerShell**（对照写法，本机未装 `pwsh`，未实测）
```powershell
bash .\swe-bench-sci\run_mentor.sh 023 $runId
```

**成功标志**：日志出现 `stage=done`；run 目录下出现 `patch-r1-mentor-polished.diff`，
且该补丁已被 apply 到 `swe-bench-sci/workspaces/task-023/`。

**产物**
```
<runId>/patch-r1-mentor-polished.diff       终审打磨后的补丁（这份才是我们的方法成果）
<runId>/mentor-progress-r1.jsonl            逐维打分进度（可实时盯）
swe-bench-sci/logs/mentor-023-<时间戳>.log
```

**常见失败**
- `缺少 patcher 候选 diff` → 第 4 步没产出候选，先跑 patcher。
- 打磨后的 diff `git apply --check` 失败 → 脚本会自动回退到原候选，日志里能看到。

### 第 6 步 · Docker 验收：跑私有测试

**执行文件**：`tools/swe-bench-science/verify-023.sh`

不带参数时，取最新 run 的 `patch-r1-ds.diff` 作为 `candidate-ds` 轮次，并**自动追加一轮
`baseline`（空补丁）**做区分度对照。

**bash**
```bash
bash tools/swe-bench-science/verify-023.sh
```

**PowerShell**（对照写法，本机未装 `pwsh`，未实测）
```powershell
bash .\tools\swe-bench-science\verify-023.sh
```

**成功标志**：末尾打印 `ALL-DONE`，并且
`/tmp/dv023/candidate-ds/verifier/reward.json` 与 `/tmp/dv023/baseline/verifier/reward.json`
都写出了分数。

**产物**
```
/tmp/dv023/candidate-ds/verifier/reward.json      你的补丁的私测分数
/tmp/dv023/candidate-ds/verifier/junit.xml        逐用例结果
/tmp/dv023/candidate-ds/verifier/test-stdout.txt  测试输出
/tmp/dv023/candidate-ds/container-stdout.txt      容器整体输出（失败时先看这个）
/tmp/dv023/baseline/verifier/reward.json          空补丁对照（期望更低，证明私测有区分度）
```

**常见失败**
- 拉取 verifier 镜像失败 → 需要网络；镜像 digest 见脚本里的 `IMG` 常量。
- 容器 `timeout 25m` 被杀 → 看 `container-stdout.txt` 的尾部。
  注意：运行环境禁止 `rm`，脚本对旧轮次目录一律 `mv` 成 `<label>.prev-<时间戳>`。

### 第 7 步 · 收尾：恢复镜像隔离 + 复跑

**执行文件**：无（手动命令）

为了让 agent 在运行期**读不到私有测试**，本机刻意不保留 verifier 镜像；`verify-023.sh`
开始时才拉取。验收完请再把它删掉，恢复隔离：

**bash**
```bash
docker rmi kevinxulearning/swe-bench-science-verifier-python-task-023@sha256:18a396490f4a3b79796d8e12d38f29e47a453a67e53c0427d8cdf4a38b33876e
```

**PowerShell**（对照写法，本机未装 `pwsh`，未实测）
```powershell
docker rmi kevinxulearning/swe-bench-science-verifier-python-task-023@sha256:18a396490f4a3b79796d8e12d38f29e47a453a67e53c0427d8cdf4a38b33876e
```

**想整体重跑一遍 023**：
```bash
rm -rf swe-bench-sci/workspaces/task-023     # 清掉工作区（含历史 run 与已 apply 的补丁）
bash tools/swe-bench-science/materialize-023.sh
PTM=30 bash swe-bench-sci/run_prober.sh 023
bash swe-bench-sci/run_patcher.sh 023 --only-roles ds --repair-timeout-min 60
bash swe-bench-sci/run_mentor.sh 023
bash tools/swe-bench-science/verify-023.sh
```

---

## 一眼看懂的步骤总表

| 步骤 | 执行文件 | 成功标志 |
|---|---|---|
| 0 环境自检 | — | 四个版本号 + `docker daemon OK` |
| 1 配置 key | — | `sk-xxxxx...` |
| 2 物化 | `tools/swe-bench-science/materialize-023.sh` | `MATERIALIZED-OK` |
| 3 SciProber | `PTM=30 bash swe-bench-sci/run_prober.sh 023` | 日志 `stage=probe-done` + `probes/manifest.json` |
| 4 SciPatcher | `swe-bench-sci/run_patcher.sh 023` | 日志 `stage=patcher-done` + `patch-r1-ds.diff` |
| 5 SciReviewer | `swe-bench-sci/run_mentor.sh 023` | 日志 `stage=done` + `patch-r1-mentor-polished.diff` |
| 6 Docker 验收 | `tools/swe-bench-science/verify-023.sh` | `ALL-DONE` + `reward.json` |
| 7 收尾 | `docker rmi …` | 镜像被删，隔离恢复 |

---

## Windows / PowerShell：0 → 023 全流程

> 本机是 Linux，**没装 `pwsh` / `powershell`，所以下面所有 PowerShell 命令都未实测**，属对照写法；
> 但每一条都写清了**执行哪个文件**，照抄即可。前提是 Windows 上已装
> **Git for Windows（自带 `bash`）** 或 **WSL**——本仓库流程脚本全是 bash 脚本，
> PowerShell 只能 `bash <脚本>` 调用，**不能直接 `.\xxx.sh`**。

### 前置（一次性）

```powershell
# ① 确认有 bash（Git Bash 或 WSL 二选一）
bash --version

# ② 依赖自检
node -v; claude --version; codex --version; docker --version

# ③ 进入仓库（路径按实际改；走 WSL 则是 cd /mnt/c/path/to/SPICE-TASK）
cd C:\path\to\SPICE-TASK
```

### 全流程 · 可整段复制

把 `C:\path\to\SPICE-TASK` 和 `sk-你的key` 换成自己的，然后**一段一段**贴进 PowerShell。
（第 3 步耗时最长，其余步骤都要等上一步出成功标志再继续。）

```powershell
# ===== SPICE · task 023 全流程（PowerShell 调 bash）=====
cd C:\path\to\SPICE-TASK

# ---- 第 0 步 · 环境自检（不执行脚本，只查版本）----
node -v; claude --version; codex --version; docker --version
docker info *> $null; if ($?) { "docker daemon OK" }

# ---- 第 1 步 · 配置 DeepSeek key（不执行脚本，只设环境变量）----
$env:DEEPSEEK_API_KEY = "sk-你的key"
$env:DEEPSEEK_API_KEY.Substring(0,7) + "..."        # 期望 sk-xxxxx...

# ---- 第 2 步 · 物化工作区：执行 tools/swe-bench-science/materialize-023.sh ----
bash ./tools/swe-bench-science/materialize-023.sh   # 期望最后一行 MATERIALIZED-OK

# ---- 第 3 步 · SciProber：执行 swe-bench-sci/run_prober.sh ----
$env:PTM = "30"                                     # 探针时限 30 分钟（脚本默认 15）
bash ./swe-bench-sci/run_prober.sh 023              # 期望日志出现 stage=probe-done
# 盯日志（可选）：
# $log = Get-ChildItem .\swe-bench-sci\logs\prober-023-*.log | Sort-Object LastWriteTime -Descending | Select-Object -First 1
# Get-Content $log.FullName -Wait -Tail 30

# ---- 取最新 runId（第 4、5、6 步都要用）----
$runId = (Get-ChildItem .\swe-bench-sci\workspaces\task-023\.codex-sci-debug\runs |
          Sort-Object LastWriteTime -Descending | Select-Object -First 1).Name
"runId = $runId"

# ---- 第 4 步 · SciPatcher：执行 swe-bench-sci/run_patcher.sh ----
bash ./swe-bench-sci/run_patcher.sh 023 $runId --only-roles ds --repair-timeout-min 60
# 期望日志 stage=patcher-done，run 目录出现 patch-r1-ds.diff

# ---- 第 5 步 · SciReviewer：执行 swe-bench-sci/run_mentor.sh ----
bash ./swe-bench-sci/run_mentor.sh 023 $runId
# 期望日志 stage=done，出现 patch-r1-mentor-polished.diff（并已 apply 到工作区）

# ---- 第 6 步 · Docker 验收：执行 tools/swe-bench-science/verify-023.sh ----
bash ./tools/swe-bench-science/verify-023.sh $runId
# 期望末尾 ALL-DONE；分数在 /tmp/dv023/<label>/verifier/reward.json

# ---- 第 7 步 · 收尾（不执行脚本）：恢复 verifier 镜像隔离 ----
docker rmi kevinxulearning/swe-bench-science-verifier-python-task-023@sha256:18a396490f4a3b79796d8e12d38f29e47a453a67e53c0427d8cdf4a38b33876e
```

### 每步执行哪个文件 · 一览

| 步骤 | 执行哪个文件 | PowerShell 命令 | 成功标志 |
|---|---|---|---|
| 0 自检 | —（无脚本） | `node -v; claude --version; codex --version; docker --version` | 四行版本号 + `docker daemon OK` |
| 1 key | —（无脚本） | `$env:DEEPSEEK_API_KEY = "sk-..."` | 打印 `sk-xxxxx...` |
| 2 物化 | `tools/swe-bench-science/materialize-023.sh` | `bash ./tools/swe-bench-science/materialize-023.sh` | `MATERIALIZED-OK` |
| 3 SciProber | `swe-bench-sci/run_prober.sh` | `$env:PTM="30"; bash ./swe-bench-sci/run_prober.sh 023` | 日志 `stage=probe-done` + `probes/manifest.json` |
| 4 SciPatcher | `swe-bench-sci/run_patcher.sh` | `bash ./swe-bench-sci/run_patcher.sh 023 $runId --only-roles ds --repair-timeout-min 60` | 日志 `stage=patcher-done` + `patch-r1-ds.diff` |
| 5 SciReviewer | `swe-bench-sci/run_mentor.sh` | `bash ./swe-bench-sci/run_mentor.sh 023 $runId` | 日志 `stage=done` + `patch-r1-mentor-polished.diff` |
| 6 验收 | `tools/swe-bench-science/verify-023.sh` | `bash ./tools/swe-bench-science/verify-023.sh $runId` | `ALL-DONE` + `reward.json` |
| 7 收尾 | —（无脚本） | `docker rmi <verifier 镜像全串>` | 镜像被删，隔离恢复 |

### 常用操作对照（bash ↔ PowerShell）

| 你想做的事 | bash 写法 | PowerShell 写法 |
|---|---|---|
| 进入仓库 | `cd ~/SPICE-TASK` | `cd C:\path\to\SPICE-TASK`（WSL: `cd /mnt/c/path/to/SPICE-TASK`） |
| 设置 key | `export DEEPSEEK_API_KEY=sk-...` | `$env:DEEPSEEK_API_KEY = "sk-..."` |
| 设置探针时限 | `PTM=30 bash swe-bench-sci/run_prober.sh 023` | `$env:PTM = "30"` 然后 `bash ./swe-bench-sci/run_prober.sh 023` |
| 后台跑 | `bash swe-bench-sci/run_prober.sh 023` | 同上（脚本自己 `setsid nohup` detach，直接 `bash ./...` 调用即可） |
| 盯日志 | `tail -f swe-bench-sci/logs/prober-023-*.log` | `Get-Content .\swe-bench-sci\logs\prober-023-<时间戳>.log -Wait -Tail 30` |
| 看进程是否还活着 | `kill -0 $(cat swe-bench-sci/logs/run-023-prober.pid)` | `Get-Process -Id (Get-Content .\swe-bench-sci\logs\run-023-prober.pid)` |
| 取最新 runId | `ls -1t swe-bench-sci/workspaces/task-023/.codex-sci-debug/runs \| head -1` | `(Get-ChildItem .\swe-bench-sci\workspaces\task-023\.codex-sci-debug\runs \| Sort-Object LastWriteTime -Descending \| Select-Object -First 1).Name` |
| 删工作区重跑 | `rm -rf swe-bench-sci/workspaces/task-023` | `Remove-Item -Recurse -Force .\swe-bench-sci\workspaces\task-023` |
| 看 key 是否生效 | `echo "${DEEPSEEK_API_KEY:0:7}"` | `$env:DEEPSEEK_API_KEY.Substring(0,7)` |

三个最容易踩的坑：

1. **PowerShell 里不能直接 `./tools/xxx.sh`**。脚本是 bash 脚本，必须 `bash ./tools/xxx.sh`
   或 `wsl bash ./tools/xxx.sh`；只装了 PowerShell、没装 Git Bash/WSL 就跑不了。
2. **路径分隔符**。传给 `bash` 的路径统一用 `/`（即使你在 PowerShell 里）更保险；
   `\` 在部分 Git Bash 场景会被当转义符。本文所有 PowerShell 命令都已用 `/`。
3. **环境变量只在当前窗口有效**。`$env:PTM`、`$env:DEEPSEEK_API_KEY` 换一个 PowerShell
   窗口就没了，要重设；持久化用 `setx DEEPSEEK_API_KEY "sk-..."`（需重开窗口）。

---

## 目录结构

```
probe_skill.md                     SciProber 的 skill 定义（隐藏契约勘查）
shots/patcher_skill.md             SciPatcher 的 skill 定义（契约与证据引导的修复）
shots/reviewer_skill.md            SciReviewer 的 skill 定义（rubric 评审与打磨）
out/                              编译产物（运行时实际加载；必须与 tools/ 同级）
src/                              TypeScript 源码（与 out/ 对应）
tools/swe-bench-science/          task 级脚本：物化、验收、runner、计量
swe-bench-sci/                    阶段 wrapper（run_prober / run_patcher / run_mentor）+ 角色配置 023.json
examples/023/                     一个完整 run 的存档产物（补丁、对比、覆盖面、验收结果）
```

## 产物位置

每次 run 的产物都在工作区内：

```
swe-bench-sci/workspaces/task-023/.codex-sci-debug/runs/<runId>/
  probes/manifest.json                 SciProber 物化的探针清单
  probe-report-tester.json             探针报告（提问 / 暴露入口 / 探针清单）
  probe-coverage.json                  覆盖面配额核对结果
  prober/<通道>/                       各通道的自名声明与探针源文件
  patch-r1-sci.diff                    三通道候选补丁
  patch-r1-general.diff
  patch-r1-ds.diff
  verify-result-r1-<通道>.json         各候选的探针 + public repro 自验结果
  comparison-r1.json                   候选横向对比（按 public 通过情况择优）
  patch-r1-mentor-polished.diff        SciReviewer 终审打磨后的补丁
```

`examples/023/` 里保存了一份同形状的存档，可直接查看产物长什么样。

## 正规名与文件/脚本对照

README 与论文里使用正规名，仓库中沿用既有的脚本与产物名，对应关系如下：

| 正规名 | skill 文件 | 阶段脚本 | 关键产物 |
|---|---|---|---|
| SciProber | `probe_skill.md` | `swe-bench-sci/run_prober.sh` | `probes/`、`probe-report-*.json` |
| SciPatcher | `shots/patcher_skill.md` | `swe-bench-sci/run_patcher.sh` | `patch-r1-*.diff`、`comparison-r1.json` |
| SciReviewer | `shots/reviewer_skill.md` | `swe-bench-sci/run_mentor.sh` | `patch-r1-mentor-polished.diff` |

历史原因，SciReviewer 的脚本名与产物名保留了 `mentor` 字样；二者指同一条 reviewer 逻辑，
尚未重命名（重命名会牵动 wrapper 与 skill 路径，收益不足）。

## 结果

所有数字来自本机 Docker verifier 实测（`reward.json`），非估算。023 的 private 套件共 8 条
用例，115 共 97 条。

**task 023**

| 方法 | public | private | reward |
|---|---|---|---|
| baseline（空补丁） | 1/1 | 5/8 | 0 |
| **SPICE（SciProber → SciPatcher → SciReviewer）** | 1/1 | **8/8** | **1** |
| MAGIS（DeepSeek pro max） | 1/1 | 5/8 | 0 |
| Agentless | 1/1 | 5/8 | 0 |

**task 115**（该任务本轮无任何方法拿到 `reward=1`）

| 方法 | private |
|---|---|
| baseline | 72/97 |
| **SPICE** | **93/97** |
| MAGIS | 73/97 |

023 上 SPICE 是唯一把 private 套件从 5/8 推到 8/8 的方法。115 上 SPICE 得分最高，但未清空
私有套件，因此 reward 仍为 0——说明该任务无论对谁都还没被解决。

`examples/023/verify-result-r1-ds.json` 还记录了一个值得注意的现象：patcher 交出的候选在
探针侧有 2/7 未过（`ok:false`），但 Docker verifier 判为 8/8 全绿。这说明**探针覆盖与私测
通过之间存在张力**：探针不全会低估补丁，也可能高估，单一信号都不足以替代私有测试。

## 关于对比方法

MAGIS 与 Agentless 都是**他人的方法**，本仓库只做调用与对照，不包含其实现：

- **MAGIS** — NeurIPS 2024，arXiv:2403.17927。
- **Agentless** — OpenAutoCoder，arXiv:2407.01489。
- **CodeR** — 已克隆但未找到可运行入口，**我们没跑过**，故不上表。

两个方法都需要各自的 API key 与环境配置，请参照其官方仓库。

## 不可随意改名的位置

以下几处是硬编码绑定，改名会导致运行期找不到文件：

- `shots/` 目录名与 `probe_skill.md` / `patcher_skill.md` / `reviewer_skill.md` 文件名：
  orchestrator 从工作区逐级向上按 `shots/<文件名>` 查找 skill，不是配置项。
- `out/` 必须与 `tools/` 同级：`run-dual-075.js` 以相对路径引用 `out/orchestrator/orchestrator`。
- `swe-bench-sci/` 目录名：wrapper 用自身位置推导 `workspaces/task-NNN` 与 `NNN.json`。
- `.codex-sci-debug/` 产物目录名：工件路径与归档逻辑都按该名硬编码。

## 运行配置

`swe-bench-sci/023.json` 是 023 的角色→模型→提供商→密钥的唯一配置源：

| 角色 | 分支 | 模型 | thinking | 备注 |
|---|---|---|---|---|
| `tester`（= ds 通道） | **codex exec** | `deepseek-chat` | max | prober 实际执行者 |
| `kimi` | codex exec | `deepseek-chat` | max | 未启用，`--only-roles ds` 时只参与 key 校验 |
| `domain-invariant`(sci) / `repair`(general) / `ds` | **claude -p** | `deepseek-v4-pro` | max | patcher 三通道 |
| `mentor` | **claude -p** | `deepseek-v4-pro` | max | SciReviewer |

- 探针时限：`023.json` 声明 30 分钟，**运行时默认 15 分钟，需显式 `PTM=30` 才是 30 分钟**。
- 修复时限：`--repair-timeout-min`，默认 20 分钟，`0` = 不限时。
- `mentorMaxRegenRounds: 0`：ds-only 流程不做 mentor 重生成。
- 离线硬约束：禁用 WebSearch/WebFetch，禁止查上游仓库或他人补丁，禁止读历史 run 产物当答案。

`providers` 里残留的 `local-qwen` / `moonshot` / `siliconflow` 是已弃用条目，当前没有任何角色
引用它们，preflight 也不会校验。

## 第三方组件

`out/` 与 `src/` 中的 `codexClient.ts`、`extension.ts` 是 VS Code 扩展入口，依赖 `vscode`
模块，**headless 流水线不会加载它们**；本 README 的命令只需要 Node、Claude Code CLI、
Codex CLI 和 Docker。
