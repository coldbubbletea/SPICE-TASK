import { spawn, ChildProcess } from 'child_process';
import * as vscode from 'vscode';
import { Backend, BackendEvent } from './chatPanel';

interface CodexClientOptions {
  codexPath: string;
  model: string;
  sandbox: string;
  cwd: string;
  domainContext: string;
}

export class CodexClient implements Backend {
  public onEvent: (event: BackendEvent) => void = () => {};
  private process?: ChildProcess;
  private threadId?: string;
  private firstSend = true;

  constructor(private readonly options: CodexClientOptions) {}

  public static fromConfig(cwd: string): CodexClient {
    const cfg = vscode.workspace.getConfiguration('codexSciDebug');
    return new CodexClient({
      codexPath: cfg.get<string>('codexPath', 'codex'),
      model: cfg.get<string>('model', ''),
      sandbox: cfg.get<string>('sandbox', 'workspace-write'),
      cwd,
      domainContext: cfg.get<string>('domainContext', '')
    });
  }

  send(message: string): void {
    this.cancel();
    this.onEvent({ type: 'status', status: 'running' });

    const isResume = !this.firstSend && this.threadId !== undefined;
    const prompt =
      !isResume && this.options.domainContext
        ? `${this.options.domainContext}\n\n${message}`
        : message;

    let args: string[];
    if (isResume) {
      args = ['exec', 'resume', this.threadId as string, '--json', '--skip-git-repo-check', prompt];
    } else {
      args = ['exec', '--json', '--sandbox', this.options.sandbox, '--skip-git-repo-check', '-C', this.options.cwd];
      if (this.options.model) {
        args.push('-c', `model=${this.options.model}`);
      }
      args.push(prompt);
    }

    let child: ChildProcess;
    try {
      child = spawn(this.options.codexPath, args, {
        cwd: this.options.cwd,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      this.onEvent({ type: 'error', message: `无法启动 codex：${err}。请检查 codexSciDebug.codexPath 配置。` });
      this.onEvent({ type: 'status', status: 'error' });
      return;
    }
    this.process = child;
    this.firstSend = false;

    let buffer = '';
    child.stdout?.on('data', (data: Buffer) => {
      buffer += data.toString('utf8');
      let newline: number;
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
    child.on('error', (err: NodeJS.ErrnoException) => {
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
      } else {
        this.onEvent({ type: 'status', status: 'idle' });
      }
    });
  }

  cancel(): void {
    if (this.process) {
      this.process.kill('SIGTERM');
      this.process = undefined;
    }
  }

  private handleLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      this.onEvent({ type: 'text', text: line + '\n' });
      return;
    }
    const event = parsed as {
      type?: string;
      thread_id?: string;
      item?: { type?: string; text?: string; command?: string; exit_code?: number };
      message?: string;
    };
    if (event.type === 'thread.started' && event.thread_id) {
      this.threadId = event.thread_id;
      return;
    }
    if (event.type === 'item.completed' && event.item) {
      const item = event.item;
      if (item.type === 'agent_message' && item.text) {
        this.onEvent({ type: 'text', text: item.text });
      } else if (item.type === 'command_execution') {
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
