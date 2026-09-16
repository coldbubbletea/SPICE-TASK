import * as vscode from 'vscode';
import { ChatViewProvider, Backend } from './chatPanel';
import { MockBackend } from './mockBackend';
import { CodexClient } from './codexClient';
import { runPipeline, PipelineEvent } from './orchestrator/orchestrator';
import { runDockerVerify } from './orchestrator/dockerVerify';
import { expertRoles } from './agents/experts';
import { ModelProviderConfig } from './agents/runner';
import * as path from 'path';
import * as fs from 'fs';

interface RunStateFile {
  runId: string;
  stage: string;
  verifySummary?: string;
  failedExperts?: string[];
  retries?: number;
}

function runsDirOf(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.codex-sci-debug', 'runs');
}

export function scanRuns(workspaceRoot?: string): { runId: string; time: string; ok: boolean | null; summary: string }[] {
  if (!workspaceRoot) {
    return [];
  }
  let entries: string[];
  try {
    entries = fs.readdirSync(runsDirOf(workspaceRoot));
  } catch {
    return [];
  }
  const items = [];
  for (const entry of entries) {
    try {
      const state: RunStateFile = JSON.parse(fs.readFileSync(path.join(runsDirOf(workspaceRoot), entry, 'run-state.json'), 'utf8'));
      const ok = state.stage === 'done' ? true : state.stage === 'failed' ? false : null;
      items.push({
        runId: state.runId,
        time: state.runId.replace('T', ' ').slice(0, 19),
        ok,
        summary: state.verifySummary ?? (state.stage === 'failed' ? '流水线失败' : '进行中')
      });
    } catch {
      // 跳过不完整的历史目录
    }
  }
  return items.sort((a, b) => b.runId.localeCompare(a.runId)).slice(0, 50);
}

/** 设置中配置的模型提供商（id → 连接参数）。 */
interface ProviderConfig {
  baseUrl: string;
  name?: string;
  wireApi?: string;
  envKey?: string;
}

/** 按 id 解析提供商配置；未配置或缺少 baseUrl 时返回 undefined。 */
function resolveProvider(
  id: string | undefined,
  providers: Record<string, ProviderConfig>
): ModelProviderConfig | undefined {
  if (!id) {
    return undefined;
  }
  const p = providers[id];
  if (!p?.baseUrl) {
    return undefined;
  }
  return {
    id,
    name: p.name ?? id,
    baseUrl: p.baseUrl,
    wireApi: p.wireApi,
    envKey: p.envKey
  };
}

/** 从设置读取每个角色的提供商配置（role → provider 配置）。 */
function resolveRoleProviders(
  cfg: vscode.WorkspaceConfiguration
): Record<string, ModelProviderConfig> {
  const providers = cfg.get<Record<string, ProviderConfig>>('providers', {}) ?? {};
  const byRole = cfg.get<Record<string, string>>('expertProviders', {}) ?? {};
  const resolved: Record<string, ModelProviderConfig> = {};
  for (const [role, pid] of Object.entries(byRole)) {
    const p = resolveProvider(pid, providers);
    if (p) {
      resolved[role] = p;
    }
  }
  return resolved;
}

function createBackend(): Backend {
  const cfg = vscode.workspace.getConfiguration('codexSciDebug');
  if (cfg.get<string>('backend', 'codex') === 'mock') {
    return new MockBackend();
  }
  const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
  return CodexClient.fromConfig(cwd);
}

export function activate(context: vscode.ExtensionContext): void {
  const backend = createBackend();
  const provider = new ChatViewProvider(context.extensionUri, backend);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewType, provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codexSciDebug.openChat', async () => {
      await vscode.commands.executeCommand('codexSciDebug.chatView.focus');
      provider.reveal();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('codexSciDebug.debugSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('Codex Sci: 没有打开的编辑器。');
        return;
      }
      const selection = editor.selection;
      const code = editor.document.getText(selection);
      if (!code.trim()) {
        vscode.window.showWarningMessage('Codex Sci: 请先选中一段代码。');
        return;
      }
      const errorInfo = await vscode.window.showInputBox({
        prompt: '补充报错信息（可选，留空直接回车）',
        placeHolder: '例如：Segmentation fault at born.F90:312 …'
      });
      if (errorInfo === undefined) {
        return;
      }
      const relPath = vscode.workspace.asRelativePath(editor.document.uri);
      const startLine = selection.start.line + 1;
      const endLine = selection.end.line + 1;
      const message =
        `请帮我 debug 下面这段代码。\n` +
        `文件：${relPath}（${editor.document.languageId}，第 ${startLine}-${endLine} 行）\n` +
        `\`\`\`${editor.document.languageId}\n${code}\n\`\`\`\n` +
        (errorInfo.trim() ? `\n报错信息：\n${errorInfo.trim()}\n` : '');
      await vscode.commands.executeCommand('codexSciDebug.chatView.focus');
      provider.reveal();
      provider.sendUserMessage(message);
    })
  );

  let pipelineRunning = false;

  const launchPipeline = async (errorInfo: string) => {
    if (pipelineRunning) {
      vscode.window.showWarningMessage('Codex Sci: 多 Agent 流水线正在运行中。');
      return;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showWarningMessage('Codex Sci: 请先打开一个 workspace 文件夹。');
      return;
    }
    const editor = vscode.window.activeTextEditor;
    let contextPart = '';
    if (editor) {
      const selection = editor.selection;
      const code = editor.document.getText(selection);
      const relPath = vscode.workspace.asRelativePath(editor.document.uri);
      contextPart = code.trim()
        ? `相关代码（${relPath}，${editor.document.languageId}，第 ${selection.start.line + 1}-${selection.end.line + 1} 行）：\n\`\`\`${editor.document.languageId}\n${code}\n\`\`\`\n`
        : `相关文件：${relPath}\n`;
    }
    const intake = `用户（非专业程序员）报告的问题：\n${errorInfo.trim()}\n\n` + contextPart;

    const cfg = vscode.workspace.getConfiguration('codexSciDebug');
    await vscode.commands.executeCommand('codexSciDebug.chatView.focus');
    provider.reveal();
    const post = (text: string) => provider.postPipelineEvent(text);
    const ui = (payload: unknown) => provider.postPipelineUi(payload);

    const emit = (event: PipelineEvent) => {
      if (event.type === 'stage') {
        post(`\n=== 阶段: ${event.stage}${event.detail ? '（' + event.detail + '）' : ''} ===`);
        ui({ action: 'stage', stage: event.stage });
      } else if (event.type === 'expert') {
        post(`专家 ${event.role}: ${event.status === 'started' ? '开始分析…' : event.status === 'done' ? '完成 ✓' : '失败 ✗'}`);
        ui({ action: 'expert', role: event.role, status: event.status });
      } else if (event.type === 'report') {
        const r = event.report;
        post(`[${r.role}] 提问 ${r.questions.length} 个，暴露入口 ${r.exposure_paths.length} 条，探针 ${r.probes.length} 个`);
      } else if (event.type === 'retry') {
        post(`⚠ 第 ${event.round} 次打回：${event.reason}`);
        ui({ action: 'retry', round: event.round });
      } else if (event.type === 'patch') {
        post(`📄 已记录补丁（第 ${event.round} 轮，来源 ${event.source}）：${event.path}`);
      } else if (event.type === 'mentor') {
        post(`⚖️ SciReviewer 评审（第 ${event.round} 轮，选择：${event.choice ?? '—'}）：${event.summary}`);
        ui({ action: 'mentor', round: event.round, verdict: event.verdict, summary: event.summary });
      } else if (event.type === 'activity') {
        post(`📋 ${event.text}`);
      } else if (event.type === 'finished') {
        post(`\n${event.ok ? '✅ 完成' : '❌ 失败'}：${event.summary}`);
        ui({ action: 'finished', ok: event.ok, summary: event.summary });
      }
    };

    post(`\n🔬 启动多 Agent 探测流水线…`);
    ui({ action: 'start' });
    pipelineRunning = true;
    try {
      await runPipeline(intake, {
        codexPath: cfg.get<string>('codexPath', 'codex'),
        model: cfg.get<string>('model', ''),
        sandbox: 'read-only',
        cwd: workspaceRoot,
        workspaceRoot,
        publicCommand: cfg.get<string>('publicCommand', ''),
        maxRetries: cfg.get<number>('maxRetries', 2),
          expertTimeoutMs: cfg.get<number>('expertTimeoutMinutes', 20) * 60 * 1000,
          repairTimeoutMs: cfg.get<number>('repairTimeoutMinutes', 60) * 60 * 1000,
          pythonPath: cfg.get<string>('pythonPath', '') || undefined,
        artifactsRoot: path.join(workspaceRoot, '.codex-sci-debug', 'runs')
      ,
      expertModels: cfg.get<Record<string, string>>('expertModels', {}) ?? {},
      repairModel: cfg.get<string>('repairModel', ''),
      expertKeys: cfg.get<Record<string, string>>('expertKeys', {}) ?? {},
      repairKey: cfg.get<string>('repairKey', ''),
      mentorModel: cfg.get<string>('mentorModel', ''),
      mentorKey: cfg.get<string>('mentorKey', ''),
      mentorProvider: resolveProvider(
        cfg.get<string>('mentorProvider', ''),
        cfg.get<Record<string, ProviderConfig>>('providers', {}) ?? {}
      ),
      mentorMaxRegenerations: cfg.get<number>('mentorMaxRegenerations', 1),
      expertProviders: resolveRoleProviders(cfg),
      expertKnowledge: cfg.get<Record<string, string>>('expertKnowledge', {}) ?? {},
      knowledgeDir: cfg.get<string>('knowledgeDir', '') || undefined,
      repairProvider: resolveProvider(
        cfg.get<string>('repairProvider', ''),
        cfg.get<Record<string, ProviderConfig>>('providers', {}) ?? {}
      )
      }, emit);
    } catch (err) {
      post(`流水线异常：${err}`);
    } finally {
      pipelineRunning = false;
      provider.postHistory();
    }
  };

  provider.onProbeDebug = (text) => {
    void launchPipeline(text);
  };

  provider.onHistoryRequest = () => scanRuns(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath);

  provider.onAgentModels = async (expertModels, repairModel, mentorModel) => {
    const cfg = vscode.workspace.getConfiguration('codexSciDebug');
    const cleaned: Record<string, string> = {};
    for (const role of expertRoles()) {
      if (expertModels[role]) cleaned[role] = expertModels[role];
    }
    await cfg.update('expertModels', cleaned, vscode.ConfigurationTarget.Global);
    await cfg.update('repairModel', repairModel, vscode.ConfigurationTarget.Global);
    await cfg.update('mentorModel', mentorModel ?? '', vscode.ConfigurationTarget.Global);
    const desc =
      Object.entries(cleaned).map(([r, m]) => `${r}=${m}`).join(', ') || '专家全部默认';
    provider.postPipelineEvent(
      `🎛 模型分配已更新：${desc}${repairModel ? `，SciPatcher (general)=${repairModel}` : ''}${mentorModel ? `，SciReviewer=${mentorModel}` : ''}`
    );
  };

  provider.initialAgentModels = () => {
    const cfg = vscode.workspace.getConfiguration('codexSciDebug');
    return {
      roles: expertRoles(),
      expertModels: cfg.get<Record<string, string>>('expertModels', {}) ?? {},
      repairModel: cfg.get<string>('repairModel', ''),
      mentorModel: cfg.get<string>('mentorModel', '')
    };
  };

  provider.onAgentKeys = async (expertKeys, repairKey, mentorKey) => {
    const cfg = vscode.workspace.getConfiguration('codexSciDebug');
    const cleaned: Record<string, string> = {};
    for (const role of expertRoles()) {
      if (expertKeys[role]) cleaned[role] = expertKeys[role];
    }
    await cfg.update('expertKeys', cleaned, vscode.ConfigurationTarget.Global);
    await cfg.update('repairKey', repairKey, vscode.ConfigurationTarget.Global);
    await cfg.update('mentorKey', mentorKey ?? '', vscode.ConfigurationTarget.Global);
    const mask = (k: string) => `${k.slice(0, 4)}****`;
    const desc =
      Object.entries(cleaned).map(([r, k]) => `${r}=${mask(k)}`).join(', ') || '专家全部使用全局凭证';
    provider.postPipelineEvent(
      `🔑 API 密钥已更新：${desc}${repairKey ? `，SciPatcher (general)=${mask(repairKey)}` : ''}${mentorKey ? `，SciReviewer=${mask(mentorKey)}` : ''}`
    );
  };

  provider.initialAgentKeys = () => {
    const cfg = vscode.workspace.getConfiguration('codexSciDebug');
    return {
      roles: expertRoles(),
      expertKeys: cfg.get<Record<string, string>>('expertKeys', {}) ?? {},
      repairKey: cfg.get<string>('repairKey', ''),
      mentorKey: cfg.get<string>('mentorKey', '')
    };
  };

  provider.onKnowledgeDir = async (dir) => {
    const cfg = vscode.workspace.getConfiguration('codexSciDebug');
    await cfg.update('knowledgeDir', dir, vscode.ConfigurationTarget.Global);
    provider.postPipelineEvent(dir ? `📚 知识目录已更新：${dir}` : '📚 知识目录已清空（仅使用内置清单）');
  };

  provider.initialKnowledgeDir = () => {
    const cfg = vscode.workspace.getConfiguration('codexSciDebug');
    return cfg.get<string>('knowledgeDir', '') ?? '';
  };

  let dockerVerifying = false;
  provider.onDockerVerify = async () => {
    if (dockerVerifying) {
      provider.postPipelineEvent('🐳 Docker 验证正在运行中，请稍候…');
      return;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      vscode.window.showWarningMessage('Codex Sci: 请先打开一个 workspace 文件夹。');
      return;
    }
    const cfg = vscode.workspace.getConfiguration('codexSciDebug');
    const image = cfg.get<string>('verifierImage', '');
    if (!image) {
      vscode.window.showWarningMessage('Codex Sci: 请先配置 codexSciDebug.verifierImage（docker verifier 镜像）。');
      return;
    }
    const post = (text: string) => provider.postPipelineEvent(text);
    dockerVerifying = true;
    post('\n🐳 开始 Docker 验证：抓取工作区 diff → 写入 model.patch → 运行 verifier 镜像…');
    try {
      const result = await runDockerVerify({
        workspaceRoot,
        verifierImage: image,
        patchPathPrefix: cfg.get<string>('patchPathPrefix', 'source/'),
        workDir: path.join(workspaceRoot, '.codex-sci-debug', 'docker')
      });
      if (result.reward !== undefined) {
        post(`${result.ok ? '✅' : '❌'} Docker 验证完成，reward = ${result.reward}\n${result.output}\npatch: ${result.patchFile}`);
      } else {
        post(`❌ Docker 验证未完成：${result.error ?? ''}\n${result.output}`);
      }
    } catch (err) {
      post(`❌ Docker 验证出错：${err}`);
    } finally {
      dockerVerifying = false;
    }
  };

  provider.onOpenRun = (runId) => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      return;
    }
    const runDir = path.join(runsDirOf(workspaceRoot), runId);
    try {
      const state: RunStateFile = JSON.parse(fs.readFileSync(path.join(runDir, 'run-state.json'), 'utf8'));
      const files = fs.readdirSync(runDir).join(', ');
      provider.postPipelineEvent(
        `\n📂 历史运行 ${runId}\n` +
        `阶段: ${state.stage}，打回: ${state.retries ?? 0} 次${state.failedExperts?.length ? `，失败专家: ${state.failedExperts.join(', ')}` : ''}\n` +
        `验证结论: ${state.verifySummary ?? '（无）'}\n` +
        `工件文件: ${files}\n` +
        `目录: ${runDir}`
      );
    } catch (err) {
      provider.postPipelineEvent(`读取历史运行失败：${err}`);
    }
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('codexSciDebug.probeDebug', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showWarningMessage('Codex Sci: 没有打开的编辑器。');
        return;
      }
      const errorInfo = await vscode.window.showInputBox({
        prompt: '描述你遇到的问题 / 粘贴报错（必填）',
        placeHolder: '例如：python reproduce.py 报 ValueError: element ordering mismatch …'
      });
      if (!errorInfo?.trim()) {
        return;
      }
      await launchPipeline(errorInfo);
    })
  );
}

export function deactivate(): void {}
