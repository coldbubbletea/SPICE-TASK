#!/usr/bin/env python3
"""监控 runner 日志的实时输出与思考流（[think]/[tool] 格式化显示）。

用法:
  python3 swe-bench-sci/monitor_stream.py                 # 自动找 050 最新日志（patcher 优先）
  python3 swe-bench-sci/monitor_stream.py /path/to.log    # 指定日志
  python3 swe-bench-sci/monitor_stream.py 119             # 按 task 编号找日志
  选项: --kind patcher|prober   --tool-max 160（工具参数截断长度）  --raw（原始行）
Ctrl-C 退出。
"""
import argparse, json, os, re, sys, time

C = {"dim": "\x1b[2m", "reset": "\x1b[0m", "yellow": "\x1b[33m",
     "cyan": "\x1b[36m", "bold": "\x1b[1m", "green": "\x1b[32m", "red": "\x1b[31m"}

def find_log(task, kind):
    here = os.path.dirname(os.path.abspath(__file__))
    logs = os.path.join(here, "logs")
    pats = [f"{kind}-{task}-*.log"] if kind else []
    if not kind:
        pats = [f"patcher-{task}-*.log", f"prober-{task}-*.log", f"pipeline-{task}-*.log"]
    for pat in pats:
        cands = sorted(
            (os.path.join(logs, f) for f in os.listdir(logs) if re.match(pat.replace("*", r".*"), f)),
            key=os.path.getmtime, reverse=True)
        if cands:
            return cands[0]
    return None

def parse_tool(line, tool_max):
    """'[tool] Bash {"command":"..."}' -> '» Bash: <cmd 截断>'"""
    m = re.match(r"^\[tool\] (\w+)(?:\s+(\{.*\}))?\s*$", line)
    if not m:
        return line
    name, raw = m.group(1), m.group(2)
    brief = ""
    if raw:
        try:
            d = json.loads(raw)
        except Exception:
            d = None
        if isinstance(d, dict):
            for k in ("command", "file_path", "cmd", "pattern", "description"):
                if k in d and str(d[k]).strip():
                    v = str(d[k]).replace("\n", " ⏎ ")
                    brief = v[:tool_max] + ("…" if len(v) > tool_max else "")
                    break
        if not brief:
            brief = raw[:tool_max] + ("…" if len(raw) > tool_max else "")
    return f"{C['green']}» {name}{C['reset']}: {brief}"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("path_or_task", nargs="?", default="050")
    ap.add_argument("--kind", choices=["patcher", "prober"], default="")
    ap.add_argument("--tool-max", type=int, default=160)
    ap.add_argument("--raw", action="store_true")
    a = ap.parse_args()

    if os.path.isfile(a.path_or_task):
        log = os.path.abspath(a.path_or_task)
    else:
        task = a.path_or_task
        log = find_log(task, a.kind)
    if not log:
        sys.exit(f"未找到日志（task={a.path_or_task}），请显式传日志路径")
    print(f"{C['cyan']}监控: {log}{C['reset']}（Ctrl-C 退出）", flush=True)

    pos = 0
    last_out = time.time()
    while True:
        try:
            with open(log, "r", errors="replace") as f:
                f.seek(pos)
                chunk = f.read()
                pos = f.tell()
        except FileNotFoundError:
            break
        if chunk:
            last_out = time.time()
            for line in chunk.splitlines():
                if a.raw:
                    print(line, flush=True)
                    continue
                if line.startswith("[think]"):
                    print(f"{C['yellow']}⟨想⟩{C['reset']}{line[7:]}", flush=True)
                elif line.startswith("[tool]"):
                    print(parse_tool(line, a.tool_max), flush=True)
                elif line.startswith("[claude]"):
                    print(f"{C['cyan']}{line}{C['reset']}", flush=True)
                elif re.match(r"^\[\d{2}:\d{2}:\d{2}\]", line):
                    print(f"{C['bold']}{line}{C['reset']}", flush=True)
                elif line.strip():
                    print(f"{C['dim']}  {line}{C['reset']}", flush=True)
        elif time.time() - last_out > 30:
            idle = int(time.time() - last_out)
            print(f"{C['dim']}· 静默 {idle}s（无新输出，可能在大段思考/验证中）{C['reset']}", flush=True)
            last_out = time.time()
        time.sleep(1)

if __name__ == "__main__":
    import signal
    signal.signal(signal.SIGPIPE, signal.SIG_DFL)
    try:
        main()
    except KeyboardInterrupt:
        print(f"\n{C['dim']}已停止监控{C['reset']}")
    except BrokenPipeError:
        pass
