"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCodexOnce = runCodexOnce;
const child_process_1 = require("child_process");
const fs = __importStar(require("fs"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * codex CLI 的模型/提供商覆盖参数（model + model_provider + 内联 model_providers.* + reasoning effort）。
 * 新建会话与 `exec resume` 断点续跑两条路径必须共用：resume 不继承上一会话的本轮 -c 覆盖，
 * 漏注入会让 patcher 静默掉到全局默认模型。
 */
function pushCodexModelArgs(args, options, provider) {
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
function runCodexOnce(prompt, options) {
    return new Promise((resolve) => {
        const provider = options.provider;
        const isClaude = provider?.harness === 'claude';
        let args;
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
        }
        else if (options.resumeThreadId) {
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
        }
        else {
            args = ['exec', '--json', '--sandbox', options.sandbox, '--skip-git-repo-check', '-C', options.cwd];
            // 本地测试硬约束（2026-09-16）：codex harness 同样禁止联网搜索（与 claude harness 的 --disallowedTools 对齐）
            args.push('-c', 'tools.web_search=false');
            pushCodexModelArgs(args, options, provider);
            args.push(prompt);
        }
        const startedAtMs = Date.now();
        let child;
        try {
            child = (0, child_process_1.spawn)(isClaude ? 'claude' : options.codexPath, args, {
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
        }
        catch (err) {
            resolve({ ok: false, text: '', error: String(err) });
            return;
        }
        let buffer = '';
        let stderrTail = '';
        let text = '';
        let threadId;
        let error;
        let settled = false;
        // ★ claude stream-json 实时模式：每个事件实时追加 <rawLogPath> 同级 .stream.jsonl，
        //   并把 thinking/文本/工具调用实时回显到 stdout（--fg 时直达终端；后台模式进 log 文件）。
        const claudeStreamLogPath = isClaude && options.rawLogPath
            ? options.rawLogPath.replace(/\.raw\.txt$/, '.stream.jsonl')
            : undefined;
        const seenResult = { value: false };
        const handleClaudeLine = (line) => {
            let ev;
            try {
                ev = JSON.parse(line);
            }
            catch {
                return;
            }
            if (claudeStreamLogPath) {
                try {
                    fs.mkdirSync(path.dirname(claudeStreamLogPath), { recursive: true });
                    fs.appendFileSync(claudeStreamLogPath, line + '\n');
                }
                catch { /* 流日志失败不阻塞主流程 */ }
            }
            const live = (s) => process.stdout.write(`\n${s}\n`);
            switch (ev.type) {
                case 'system':
                    if (ev.subtype === 'init')
                        live(`[claude] session=${ev.session_id ?? '?'} model=${ev.model ?? ''}`);
                    break;
                case 'assistant': {
                    for (const b of ev.message?.content ?? []) {
                        if (b.type === 'thinking' && b.thinking)
                            live(`[think] ${b.thinking.trim()}`);
                        else if (b.type === 'text' && b.text)
                            live(b.text.trim());
                        else if (b.type === 'tool_use')
                            live(`[tool] ${b.name ?? ''} ${JSON.stringify(b.input ?? {}).slice(0, 200)}`);
                    }
                    break;
                }
                case 'result':
                    seenResult.value = true;
                    if (typeof ev.result === 'string' && ev.result)
                        text = ev.result;
                    if (ev.session_id)
                        threadId = ev.session_id;
                    if (ev.is_error || ev.subtype === 'error')
                        error = ev.error ? String(ev.error) : `claude error (subtype=${ev.subtype ?? 'unknown'})`;
                    live(`[claude:result] is_error=${!!ev.is_error} subtype=${ev.subtype ?? ''}`);
                    break;
                default:
                    break;
            }
        };
        // ★ timeoutMs <= 0 = 不限时（无限时间）：不建定时器，会话跑到自然结束才收尾。
        //   缺省仍回落 DEFAULT_TIMEOUT_MS。
        const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        const timer = timeoutMs > 0
            ? setTimeout(() => {
                if (!settled) {
                    settled = true;
                    child.kill('SIGTERM');
                    resolve({ ok: false, text, threadId, error: 'timeout' });
                }
            }, timeoutMs)
            : undefined;
        const finish = (ok) => {
            if (!settled) {
                settled = true;
                if (timer)
                    clearTimeout(timer);
                resolve({ ok, text, threadId, error });
            }
        };
        const handleLine = (line) => {
            let event;
            try {
                event = JSON.parse(line);
            }
            catch {
                return;
            }
            if (event.type === 'thread.started' && event.thread_id) {
                threadId = event.thread_id;
            }
            else if (event.type === 'item.completed' && event.item?.type === 'agent_message' && event.item.text) {
                text += event.item.text;
            }
            else if (event.type === 'item.completed' && event.item?.type === 'command_execution') {
                options.onActivity?.(`$ ${event.item.command ?? ''}`);
            }
            else if (event.type === 'error') {
                error = event.message ?? 'unknown codex error';
            }
        };
        child.stdout?.on('data', (data) => {
            buffer += data.toString('utf8');
            let newline;
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
        child.stderr?.on('data', (data) => {
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
                    }
                    catch { /* raw log 失败不阻塞主流程 */ }
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
                    }
                    catch { /* jsonl 兜底缺失不阻塞主流程 */ }
                }
                if (!seenResult.value && raw) {
                    const lines = raw.split('\n').map((s) => s.trim()).filter(Boolean);
                    for (let i = lines.length - 1; i >= 0; i--) {
                        if (!lines[i].startsWith('{')) {
                            continue;
                        }
                        let parsed;
                        try {
                            parsed = JSON.parse(lines[i]);
                        }
                        catch {
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
//# sourceMappingURL=runner.js.map