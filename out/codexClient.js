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
exports.CodexClient = void 0;
const child_process_1 = require("child_process");
const vscode = __importStar(require("vscode"));
class CodexClient {
    constructor(options) {
        this.options = options;
        this.onEvent = () => { };
        this.firstSend = true;
    }
    static fromConfig(cwd) {
        const cfg = vscode.workspace.getConfiguration('codexSciDebug');
        return new CodexClient({
            codexPath: cfg.get('codexPath', 'codex'),
            model: cfg.get('model', ''),
            sandbox: cfg.get('sandbox', 'workspace-write'),
            cwd,
            domainContext: cfg.get('domainContext', '')
        });
    }
    send(message) {
        this.cancel();
        this.onEvent({ type: 'status', status: 'running' });
        const isResume = !this.firstSend && this.threadId !== undefined;
        const prompt = !isResume && this.options.domainContext
            ? `${this.options.domainContext}\n\n${message}`
            : message;
        let args;
        if (isResume) {
            args = ['exec', 'resume', this.threadId, '--json', '--skip-git-repo-check', prompt];
        }
        else {
            args = ['exec', '--json', '--sandbox', this.options.sandbox, '--skip-git-repo-check', '-C', this.options.cwd];
            if (this.options.model) {
                args.push('-c', `model=${this.options.model}`);
            }
            args.push(prompt);
        }
        let child;
        try {
            child = (0, child_process_1.spawn)(this.options.codexPath, args, {
                cwd: this.options.cwd,
                stdio: ['ignore', 'pipe', 'pipe']
            });
        }
        catch (err) {
            this.onEvent({ type: 'error', message: `无法启动 codex：${err}。请检查 codexSciDebug.codexPath 配置。` });
            this.onEvent({ type: 'status', status: 'error' });
            return;
        }
        this.process = child;
        this.firstSend = false;
        let buffer = '';
        child.stdout?.on('data', (data) => {
            buffer += data.toString('utf8');
            let newline;
            while ((newline = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newline).trim();
                buffer = buffer.slice(newline + 1);
                if (line) {
                    this.handleLine(line);
                }
            }
        });
        child.stderr?.on('data', () => {
            // codex 的日志/WARN 走 stderr，忽略
        });
        child.on('error', (err) => {
            const hint = err.code === 'ENOENT'
                ? `找不到 codex 可执行文件（${this.options.codexPath}）。请在设置中配置 codexSciDebug.codexPath。`
                : `codex 进程错误：${err.message}`;
            this.onEvent({ type: 'error', message: hint });
            this.onEvent({ type: 'status', status: 'error' });
        });
        child.on('close', (code) => {
            if (buffer.trim()) {
                this.handleLine(buffer.trim());
                buffer = '';
            }
            this.process = undefined;
            if (code !== 0) {
                this.onEvent({ type: 'error', message: `codex 退出码 ${code}` });
                this.onEvent({ type: 'status', status: 'error' });
            }
            else {
                this.onEvent({ type: 'status', status: 'idle' });
            }
        });
    }
    cancel() {
        if (this.process) {
            this.process.kill('SIGTERM');
            this.process = undefined;
        }
    }
    handleLine(line) {
        let parsed;
        try {
            parsed = JSON.parse(line);
        }
        catch {
            this.onEvent({ type: 'text', text: line + '\n' });
            return;
        }
        const event = parsed;
        if (event.type === 'thread.started' && event.thread_id) {
            this.threadId = event.thread_id;
            return;
        }
        if (event.type === 'item.completed' && event.item) {
            const item = event.item;
            if (item.type === 'agent_message' && item.text) {
                this.onEvent({ type: 'text', text: item.text });
            }
            else if (item.type === 'command_execution') {
                this.onEvent({ type: 'command', command: item.command ?? '', exitCode: item.exit_code });
            }
            return;
        }
        if (event.type === 'error') {
            this.onEvent({ type: 'error', message: event.message ?? JSON.stringify(event) });
            return;
        }
        // turn.started / turn.completed / reasoning 等事件静默忽略
    }
}
exports.CodexClient = CodexClient;
//# sourceMappingURL=codexClient.js.map