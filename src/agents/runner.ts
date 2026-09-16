import { spawn } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** 模型提供商配置：codex CLI 通过 -c 覆盖写入（OpenAI 兼容端点）；harness=claude 时改用 Claude Code CLI（Anthropic 兼容端点）。 */
export interface ModelProviderConfig {
  id: string;
  name?: string;
  baseUrl: string;
  wireApi?: string;
  envKey?: string;
  /** 思维强度（reasoning effort）：codex CLI 以 -c model_reasoning_effort=<v> 固化；claude harness 以 --effort <v> 固化。取值 low/high/max。 */
  reasoningEffort?: string;
  /** 执行 harness：codex（默认）或 claude（Claude Code CLI + Anthropic 兼容端点）。 */
  harness?: string;
  /** claude harness 的 Anthropic 兼容 base_url（缺省回退 baseUrl）。 */
  claudeBaseUrl?: string;
  /** claude harness 固定思维强度（--effort），缺省 max。 */
  effort?: string;
  /** claude harness 美元预算硬上限（--max-budget-usd）；缺省不设限。省钱旋钮。 */
  maxBudgetUsd?: number;
  /** claude harness 附加 settings（--settings <文件路径|内联 JSON>）：用于压过 ~/.claude/settings.json 的 env 劫持（同名 env 用户级设置会盖掉进程环境变量）。 */
  claudeSettings?: string | Record<string, unknown>;
}

export interface CodexRunOptions {
  codexPath: string;
  model: string;
  sandbox: string;
  cwd: string;
  resumeThreadId?: string;
  apiKey?: string;
  provider?: ModelProviderConfig;
  timeoutMs?: number;
  onActivity?: (activity: string) => void;
  /** 若设置，运行结束后将 harness 原始 stdout（claude envelope 全文）与 stderr 尾部写入该文件，便于事后诊断截断。 */
  rawLogPath?: string;
  /** 若设置（claude harness），运行结束后把本次会话的 ~/.claude/projects/<cwd>/<session_id>.jsonl 拷贝到该文件，供报告兜底恢复。 */
  rawJsonlPath?: string;
  /** 若设置，各专家角色的 raw 日志写入该目录（<role>.raw.txt）。 */
  rawLogDir?: string;
  /** 若设置，各专家角色的 claude 会话 jsonl 兜底文件写入该目录（<role>.jsonl）。 */
  rawJsonlDir?: string;
}

export interface CodexRunResult {
  ok: boolean;
  text: string;
  threadId?: string;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * codex CLI 的模型/提供商覆盖参数（model + model_provider + 内联 model_providers.* + reasoning effort）。
 * 新建会话与 `exec resume` 断点续跑两条路径必须共用：resume 不继承上一会话的本轮 -c 覆盖，
 * 漏注入会让 patcher 静默掉到全局默认模型。
 */
function pushCodexModelArgs(args: string[], options: CodexRunOptions, provider?: ModelProviderConfig): void {
  if (options.model) {
    args.push('-c', `model=${options.model}`);
  }
  if (provider) {
    args.push('-c', `model_provider="${provider.id}"`);
    args.push('-c', `model_providers.${provider.id}.name="${provider.name ?? provider.id}"`);
    args.push('-c', `model_providers.${provider.id}.base_url="${provider.baseUrl}"`);
    args.push('-c', `model_providers.${provider.id}.wire_api="${provider.wireApi ?? 'responses'}"`);
    args.push('-c', `model_providers.${provider.id}.env_key="${provider.envKey ?? 'OPENAI_API_KEY'}"`);
    args.push('-c', `model_providers.${provider.id}.requires_openai_auth=false`);
    if (provider.reasoningEffort) {
      args.push('-c', `model_reasoning_effort=${provider.reasoningEffort}`);
    }
  }
}

/** 单次 codex exec 运行：收集最终 agent 文本与 thread_id，供专家/修复会话使用。 */
export function runCodexOnce(prompt: string, options: CodexRunOptions): Promise<CodexRunResult> {
  return new Promise((resolve) => {
    const provider = options.provider;
    const isClaude = provider?.harness === 'claude';
    let args: string[];
    if (isClaude) {
      args = ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
      // 本地测试硬约束（2026-09-14）：全程离线，禁止任何角色联网搜索/抓取资料
      args.push('--disallowedTools', 'WebSearch', 'WebFetch');
      if (provider?.claudeSettings) {
        args.push('--settings', typeof provider.claudeSettings === 'string' ? provider.claudeSettings : JSON.stringify(provider.claudeSettings));
      }
      if (options.model) {
        args.push('--model', options.model);
      }
      args.push('--effort', provider?.effort ?? provider?.reasoningEffort ?? 'max');
      // 省钱旋钮（2026-09-16）：任务 JSON providers.<name>.maxBudgetUsd → --max-budget-usd 硬上限
      if (provider?.maxBudgetUsd) {
        args.push('--max-budget-usd', String(provider.maxBudgetUsd));
      }
      if (options.resumeThreadId) {
        args.push('--resume', options.resumeThreadId);
      }
      args.push(prompt);
    } else if (options.resumeThreadId) {
      // 断点续跑：`codex exec resume` 不继承 -s/--sandbox 与 -C/--cd（靠 spawn cwd 定位），
      // 也不读 ~/.codex/config.toml 之外的本轮覆盖 —— 必须重新注入 model/provider/effort，
      // 否则会静默回落成全局默认模型（如 deepseek-flash），违反角色-模型硬约束。
      args = [
        'exec',
        'resume',
        options.resumeThreadId,
        '--json',
        '--skip-git-repo-check',
        '--dangerously-bypass-approvals-and-sandbox',
        '-c',
        'tools.web_search=false'
      ];
      pushCodexModelArgs(args, options, provider);
      args.push(prompt);
    } else {
      args = ['exec', '--json', '--sandbox', options.sandbox, '--skip-git-repo-check', '-C', options.cwd];
      // 本地测试硬约束（2026-09-16）：codex harness 同样禁止联网搜索（与 claude harness 的 --disallowedTools 对齐）
      args.push('-c', 'tools.web_search=false');
      pushCodexModelArgs(args, options, provider);
      args.push(prompt);
    }

    const startedAtMs = Date.now();
    let child;
    try {
    child = spawn(isClaude ? 'claude' : options.codexPath, args, {
      cwd: options.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: isClaude
        ? {
            ...process.env,
            ANTHROPIC_BASE_URL: provider?.claudeBaseUrl ?? provider?.baseUrl,
            ANTHROPIC_API_KEY: options.apiKey ?? process.env[provider?.envKey ?? 'DEEPSEEK_API_KEY'] ?? '',
            ANTHROPIC_MODEL: options.model ?? '',
            ANTHROPIC_SMALL_FAST_MODEL: options.model ?? ''
          }
        : options.apiKey
          ? { ...process.env, [options.provider?.envKey ?? 'OPENAI_API_KEY']: options.apiKey }
          : process.env
    });
    } catch (err) {
      resolve({ ok: false, text: '', error: String(err) });
      return;
    }

    let buffer = '';
    let stderrTail = '';
    let text = '';
    let threadId: string | undefined;
    let error: string | undefined;
    let settled = false;

    // ★ claude stream-json 实时模式：每个事件实时追加 <rawLogPath> 同级 .stream.jsonl，
    //   并把 thinking/文本/工具调用实时回显到 stdout（--fg 时直达终端；后台模式进 log 文件）。
    const claudeStreamLogPath = isClaude && options.rawLogPath
      ? options.rawLogPath.replace(/\.raw\.txt$/, '.stream.jsonl')
      : undefined;
    const seenResult = { value: false };
    const handleClaudeLine = (line: string) => {
      let ev: {
        type?: string;
        subtype?: string;
        session_id?: string;
        result?: string;
        is_error?: boolean;
        error?: string;
        model?: string;
        message?: { content?: Array<{ type?: string; thinking?: string; text?: string; name?: string; input?: unknown }> };
      };
      try {
        ev = JSON.parse(line);
      } catch {
        return;
      }
      if (claudeStreamLogPath) {
        try {
          fs.mkdirSync(path.dirname(claudeStreamLogPath), { recursive: true });
          fs.appendFileSync(claudeStreamLogPath, line + '\n');
        } catch { /* 流日志失败不阻塞主流程 */ }
      }
      const live = (s: string) => process.stdout.write(`\n${s}\n`);
      switch (ev.type) {
        case 'system':
          if (ev.subtype === 'init') live(`[claude] session=${ev.session_id ?? '?'} model=${ev.model ?? ''}`);
          break;
        case 'assistant': {
          for (const b of ev.message?.content ?? []) {
            if (b.type === 'thinking' && b.thinking) live(`[think] ${b.thinking.trim()}`);
            else if (b.type === 'text' && b.text) live(b.text.trim());
            else if (b.type === 'tool_use') live(`[tool] ${b.name ?? ''} ${JSON.stringify(b.input ?? {}).slice(0, 200)}`);
          }
          break;
        }
        case 'result':
          seenResult.value = true;
          if (typeof ev.result === 'string' && ev.result) text = ev.result;
          if (ev.session_id) threadId = ev.session_id;
          if (ev.is_error || ev.subtype === 'error') error = ev.error ? String(ev.error) : `claude error (subtype=${ev.subtype ?? 'unknown'})`;
          live(`[claude:result] is_error=${!!ev.is_error} subtype=${ev.subtype ?? ''}`);
          break;
        default:
          break;
      }
    };

    // ★ timeoutMs <= 0 = 不限时（无限时间）：不建定时器，会话跑到自然结束才收尾。
    //   缺省仍回落 DEFAULT_TIMEOUT_MS。
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer =
      timeoutMs > 0
        ? setTimeout(() => {
            if (!settled) {
              settled = true;
              child.kill('SIGTERM');
              resolve({ ok: false, text, threadId, error: 'timeout' });
            }
          }, timeoutMs)
        : undefined;

    const finish = (ok: boolean) => {
      if (!settled) {
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({ ok, text, threadId, error });
      }
    };

    const handleLine = (line: string) => {
      let event: {
        type?: string;
        thread_id?: string;
        item?: { type?: string; text?: string; command?: string };
        message?: string;
      };
      try {
        event = JSON.parse(line);
      } catch {
        return;
      }
      if (event.type === 'thread.started' && event.thread_id) {
        threadId = event.thread_id;
      } else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
        text += event.item.text;
      } else if (event.type === 'item.completed' && event.item?.type === 'command_execution') {
        options.onActivity?.(`$ ${event.item.command ?? ''}`);
      } else if (event.type === 'error') {
        error = event.message ?? 'unknown codex error';
      }
    };

    child.stdout?.on('data', (data: Buffer) => {
      buffer += data.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          handleLine(line);
          if (isClaude) {
            handleClaudeLine(line);
          }
        }
      }
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderrTail = (stderrTail + data.toString('utf8')).slice(-4000);
    });
    child.on('error', (err) => {
      error = String(err);
      finish(false);
    });
    child.on('close', (code) => {
      if (isClaude) {
        // --output-format stream-json：result 行已在 handleClaudeLine 实时捕获；此处仅对残留 buffer 兜底
        const raw = buffer.trim();
        if (options.rawLogPath) {
          try {
            fs.mkdirSync(path.dirname(options.rawLogPath), { recursive: true });
            fs.writeFileSync(options.rawLogPath, `=== exit=${code} is_error_seen=${!!error} ===\n${raw}\n=== stderr ===\n${stderrTail}`);
          } catch { /* raw log 失败不阻塞主流程 */ }
        }
        // claude 会话 jsonl 落盘兜底：stdout envelope 解析失败时，仍可从会话文件恢复最终报告。
        // 不依赖 stdout 里的 session_id（stdout 可能为空）：按项目目录内 mtime 最新且创建于本次启动之后的 jsonl 定位。
        if (options.rawJsonlPath) {
          try {
            const projDir = path.join(os.homedir(), '.claude', 'projects', options.cwd.replace(path.sep, '-'));
            const candidates = fs.readdirSync(projDir)
              .filter((f) => f.endsWith('.jsonl'))
              .map((f) => {
                const st = fs.statSync(path.join(projDir, f));
                return { f, mtimeMs: st.mtimeMs };
              })
              .filter((c) => c.mtimeMs >= startedAtMs - 5000)
              .sort((a, b) => b.mtimeMs - a.mtimeMs);
            if (candidates.length > 0) {
              fs.mkdirSync(path.dirname(options.rawJsonlPath), { recursive: true });
              fs.copyFileSync(path.join(projDir, candidates[0].f), options.rawJsonlPath);
            }
          } catch { /* jsonl 兜底缺失不阻塞主流程 */ }
        }
        if (!seenResult.value && raw) {
          const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);
          for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i].startsWith('{')) {
              continue;
            }
            let parsed: { result?: string; session_id?: string; is_error?: boolean; subtype?: string; error?: string };
            try {
              parsed = JSON.parse(lines[i]);
            } catch {
              continue;
            }
            if (typeof parsed.result === 'string' && parsed.result) {
              text = parsed.result;
            }
            if (parsed.session_id) {
              threadId = parsed.session_id;
            }
            if (parsed.is_error || parsed.subtype === 'error') {
              error = parsed.error ? String(parsed.error) : `claude error (subtype=${parsed.subtype ?? 'unknown'})`;
            }
            break;
          }
          if (!text && !error) {
            text = raw;
          }
        }
        if (code !== 0 && !error) {
          error = `claude exit code ${code}` + (stderrTail.trim() ? `; stderr: ${stderrTail.trim().slice(-2000)}` : '');
        }
        finish(code === 0 && !error);
        return;
      }
      if (buffer.trim()) {
        handleLine(buffer.trim());
      }
      if (code !== 0 && !error) {
        error = `codex exit code ${code}` + (stderrTail.trim() ? `; stderr: ${stderrTail.trim().slice(-2000)}` : '');
      }
      finish(code === 0 && !error);
    });
  });
}
