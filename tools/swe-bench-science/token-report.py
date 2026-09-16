#!/usr/bin/env python3
"""统计 claude stream-json 落盘文件的 token 用量（prober/patcher 各角色）。

用法:
  python3 tools/swe-bench-science/token-report.py <stream.jsonl>...
  python3 tools/swe-bench-science/token-report.py runDir          # 自动找 runDir/raw/*.stream.jsonl

输出: 每个文件的 input/output/cache_read/cache_create token 求和，
      以及最终 result 事件里的 usage 总和与 total_cost_usd。
"""
import json
import sys
from pathlib import Path


def report(path: Path) -> None:
    tot = {"input_tokens": 0, "output_tokens": 0,
           "cache_read_input_tokens": 0, "cache_creation_input_tokens": 0}
    msgs = 0
    result = None
    for line in path.open():
        try:
            ev = json.loads(line)
        except json.JSONDecodeError:
            continue
        if ev.get("type") == "assistant":
            u = (ev.get("message") or {}).get("usage")
            if not u:
                continue
            msgs += 1
            for k in tot:
                tot[k] += int(u.get(k) or 0)
        elif ev.get("type") == "result":
            result = ev
    print(f"== {path}")
    print(f"   assistant msgs={msgs}  "
          f"input={tot['input_tokens']:,}  output={tot['output_tokens']:,}  "
          f"cache_read={tot['cache_read_input_tokens']:,}  "
          f"cache_create={tot['cache_creation_input_tokens']:,}")
    if result is None:
        print("   (会话未结束，尚无 result 事件；上述为截至目前的累加)")
    else:
        u = result.get("usage") or {}
        print(f"   result: input={u.get('input_tokens',0):,}  output={u.get('output_tokens',0):,}  "
              f"cache_read={u.get('cache_read_input_tokens',0):,}  "
              f"cache_create={u.get('cache_creation_input_tokens',0):,}")
        print(f"   num_turns={result.get('num_turns')}  "
              f"total_cost_usd={result.get('total_cost_usd')}  "
              f"duration_ms={result.get('duration_ms')}")


def main() -> None:
    args = [Path(a) for a in sys.argv[1:]]
    if not args:
        print(__doc__)
        sys.exit(1)
    paths = []
    for a in args:
        if a.is_dir():
            paths.extend(sorted(a.glob("raw/*")) )
        else:
            paths.append(a)
    seen = []
    for p in paths:
        if p.exists() and p not in seen:
            seen.append(p)
    for p in seen:
        report(p)


if __name__ == "__main__":
    main()
