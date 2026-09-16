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
exports.scanRuns = scanRuns;
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = __importStar(require("vscode"));
const chatPanel_1 = require("./chatPanel");
const mockBackend_1 = require("./mockBackend");
const codexClient_1 = require("./codexClient");
const orchestrator_1 = require("./orchestrator/orchestrator");
const dockerVerify_1 = require("./orchestrator/dockerVerify");
const experts_1 = require("./agents/experts");
const path = __importStar(require("path"));
const fs = __importStar(require("fs"));
function runsDirOf(workspaceRoot) {
    return path.join(workspaceRoot, '.codex-sci-debug', 'runs');
}
function scanRuns(workspaceRoot) {
    if (!workspaceRoot) {
        return [];
    }
    let entries;
    try {
        entries = fs.readdirSync(runsDirOf(workspaceRoot));
    }
    catch {
        return [];
    }
    const items = [];
    for (const entry of entries) {
        try {
            const state = JSON.parse(fs.readFileSync(path.join(runsDirOf(workspaceRoot), entry, 'run-state.json'), 'utf8'));
            const ok = state.stage === 'done' ? true : state.stage === 'failed' ? false : null;
            items.push({
                runId: state.runId,
                time: state.runId.replace('T', ' ').slice(0, 19),
                ok,
                summary: state.verifySummary ?? (state.stage === 'failed' ? '流水线失败' : '进行中')
            });
        }
        catch {
            // 跳过不完整的历史目录
        }
    }
    return items.sort((a, b) => b.runId.localeCompare(a.runId)).slice(0, 50);
}
/** 按 id 解析提供商配置；未配置或缺少 baseUrl 时返回 undefined。 */
function resolveProvider(id, providers) {
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
function resolveRoleProviders(cfg) {
    const providers = cfg.get('providers', {}) ?? {};
    const byRole = cfg.get('expertProviders', {}) ?? {};
    const resolved = {};
    for (const [role, pid] of Object.entries(byRole)) {
        const p = resolveProvider(pid, providers);
        if (p) {
            resolved[role] = p;
        }
    }
    return resolved;
}
function createBackend() {
    const cfg = vscode.workspace.getConfiguration('codexSciDebug');
    if (cfg.get('backend', 'codex') === 'mock') {
        return new mockBackend_1.MockBackend();
    }
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    return codexClient_1.CodexClient.fromConfig(cwd);
}
function activate(context) {
    const backend = createBackend();
    const provider = new chatPanel_1.ChatViewProvider(context.extensionUri, backend);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(chatPanel_1.ChatViewProvider.viewType, provider));
    context.subscriptions.push(vscode.commands.registerCommand('codexSciDebug.openChat', async () => {
        await vscode.commands.executeCommand('codexSciDebug.chatView.focus');
        provider.reveal();
    }));
    context.subscriptions.push(vscode.commands.registerCommand('codexSciDebug.debugSelection', async () => {
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
        const message = `请帮我 debug 下面这段代码。\n` +
            `文件：${relPath}（${editor.document.languageId}，第 ${startLine}-${endLine} 行）\n` +
            `\`\`\`${editor.document.languageId}\n${code}\n\`\`\`\n` +
            (errorInfo.trim() ? `\n报错信息：\n${errorInfo.trim()}\n` : '');
        await vscode.commands.executeCommand('codexSciDebug.chatView.focus');
        provider.reveal();
        provider.sendUserMessage(message);
    }));
    let pipelineRunning = false;
    const launchPipeline = async (errorInfo) => {
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
        const post = (text) => provider.postPipelineEvent(text);
        const ui = (payload) => provider.postPipelineUi(payload);
        const emit = (event) => {
            if (event.type === 'stage') {
                post(`\n=== 阶段: ${event.stage}${event.detail ? '（' + event.detail + '）' : ''} ===`);
                ui({ action: 'stage', stage: event.stage });
            }
            else if (event.type === 'expert') {
                post(`专家 ${event.role}: ${event.status === 'started' ? '开始分析…' : event.status === 'done' ? '完成 ✓' : '失败 ✗'}`);
                ui({ action: 'expert', role: event.role, status: event.status });
            }
            else if (event.type === 'report') {
                const r = event.report;
                post(`[${r.role}] 提问 ${r.questions.length} 个，暴露入口 ${r.exposure_paths.length} 条，探针 ${r.probes.length} 个`);
            }
            else if (event.type === 'retry') {
                post(`⚠ 第 ${event.round} 次打回：${event.reason}`);
                ui({ action: 'retry', round: event.round });
            }
            else if (event.type === 'patch') {
                post(`📄 已记录补丁（第 ${event.round} 轮，来源 ${event.source}）：${event.path}`);
            }
            else if (event.type === 'mentor') {
                post(`⚖️ SciReviewer 评审（第 ${event.round} 轮，选择：${event.choice ?? '—'}）：${event.summary}`);
                ui({ action: 'mentor', round: event.round, verdict: event.verdict, summary: event.summary });
            }
            else if (event.type === 'activity') {
                post(`📋 ${event.text}`);
            }
            else if (event.type === 'finished') {
                post(`\n${event.ok ? '✅ 完成' : '❌ 失败'}：${event.summary}`);
                ui({ action: 'finished', ok: event.ok, summary: event.summary });
            }
        };
        post(`\n🔬 启动多 Agent 探测流水线…`);
        ui({ action: 'start' });
        pipelineRunning = true;
        try {
            await (0, orchestrator_1.runPipeline)(intake, {
                codexPath: cfg.get('codexPath', 'codex'),
                model: cfg.get('model', ''),
                sandbox: 'read-only',
                cwd: workspaceRoot,
                workspaceRoot,
                publicCommand: cfg.get('publicCommand', ''),
                maxRetries: cfg.get('maxRetries', 2),
                expertTimeoutMs: cfg.get('expertTimeoutMinutes', 20) * 60 * 1000,
                repairTimeoutMs: cfg.get('repairTimeoutMinutes', 60) * 60 * 1000,
                pythonPath: cfg.get('pythonPath', '') || undefined,
                artifactsRoot: path.join(workspaceRoot, '.codex-sci-debug', 'runs'),
                expertModels: cfg.get('expertModels', {}) ?? {},
                repairModel: cfg.get('repairModel', ''),
                expertKeys: cfg.get('expertKeys', {}) ?? {},
                repairKey: cfg.get('repairKey', ''),
                mentorModel: cfg.get('mentorModel', ''),
                mentorKey: cfg.get('mentorKey', ''),
                mentorProvider: resolveProvider(cfg.get('mentorProvider', ''), cfg.get('providers', {}) ?? {}),
                mentorMaxRegenerations: cfg.get('mentorMaxRegenerations', 1),
                expertProviders: resolveRoleProviders(cfg),
                expertKnowledge: cfg.get('expertKnowledge', {}) ?? {},
                knowledgeDir: cfg.get('knowledgeDir', '') || undefined,
                repairProvider: resolveProvider(cfg.get('repairProvider', ''), cfg.get('providers', {}) ?? {})
            }, emit);
        }
        catch (err) {
            post(`流水线异常：${err}`);
        }
        finally {
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
        const cleaned = {};
        for (const role of (0, experts_1.expertRoles)()) {
            if (expertModels[role])
                cleaned[role] = expertModels[role];
        }
        await cfg.update('expertModels', cleaned, vscode.ConfigurationTarget.Global);
        await cfg.update('repairModel', repairModel, vscode.ConfigurationTarget.Global);
        await cfg.update('mentorModel', mentorModel ?? '', vscode.ConfigurationTarget.Global);
        const desc = Object.entries(cleaned).map(([r, m]) => `${r}=${m}`).join(', ') || '专家全部默认';
        provider.postPipelineEvent(`🎛 模型分配已更新：${desc}${repairModel ? `，SciPatcher (general)=${repairModel}` : ''}${mentorModel ? `，SciReviewer=${mentorModel}` : ''}`);
    };
    provider.initialAgentModels = () => {
        const cfg = vscode.workspace.getConfiguration('codexSciDebug');
        return {
            roles: (0, experts_1.expertRoles)(),
            expertModels: cfg.get('expertModels', {}) ?? {},
            repairModel: cfg.get('repairModel', ''),
            mentorModel: cfg.get('mentorModel', '')
        };
    };
    provider.onAgentKeys = async (expertKeys, repairKey, mentorKey) => {
        const cfg = vscode.workspace.getConfiguration('codexSciDebug');
        const cleaned = {};
        for (const role of (0, experts_1.expertRoles)()) {
            if (expertKeys[role])
                cleaned[role] = expertKeys[role];
        }
        await cfg.update('expertKeys', cleaned, vscode.ConfigurationTarget.Global);
        await cfg.update('repairKey', repairKey, vscode.ConfigurationTarget.Global);
        await cfg.update('mentorKey', mentorKey ?? '', vscode.ConfigurationTarget.Global);
        const mask = (k) => `${k.slice(0, 4)}****`;
        const desc = Object.entries(cleaned).map(([r, k]) => `${r}=${mask(k)}`).join(', ') || '专家全部使用全局凭证';
        provider.postPipelineEvent(`🔑 API 密钥已更新：${desc}${repairKey ? `，SciPatcher (general)=${mask(repairKey)}` : ''}${mentorKey ? `，SciReviewer=${mask(mentorKey)}` : ''}`);
    };
    provider.initialAgentKeys = () => {
        const cfg = vscode.workspace.getConfiguration('codexSciDebug');
        return {
            roles: (0, experts_1.expertRoles)(),
            expertKeys: cfg.get('expertKeys', {}) ?? {},
            repairKey: cfg.get('repairKey', ''),
            mentorKey: cfg.get('mentorKey', '')
        };
    };
    provider.onKnowledgeDir = async (dir) => {
        const cfg = vscode.workspace.getConfiguration('codexSciDebug');
        await cfg.update('knowledgeDir', dir, vscode.ConfigurationTarget.Global);
        provider.postPipelineEvent(dir ? `📚 知识目录已更新：${dir}` : '📚 知识目录已清空（仅使用内置清单）');
    };
    provider.initialKnowledgeDir = () => {
        const cfg = vscode.workspace.getConfiguration('codexSciDebug');
        return cfg.get('knowledgeDir', '') ?? '';
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
        const image = cfg.get('verifierImage', '');
        if (!image) {
            vscode.window.showWarningMessage('Codex Sci: 请先配置 codexSciDebug.verifierImage（docker verifier 镜像）。');
            return;
        }
        const post = (text) => provider.postPipelineEvent(text);
        dockerVerifying = true;
        post('\n🐳 开始 Docker 验证：抓取工作区 diff → 写入 model.patch → 运行 verifier 镜像…');
        try {
            const result = await (0, dockerVerify_1.runDockerVerify)({
                workspaceRoot,
                verifierImage: image,
                patchPathPrefix: cfg.get('patchPathPrefix', 'source/'),
                workDir: path.join(workspaceRoot, '.codex-sci-debug', 'docker')
            });
            if (result.reward !== undefined) {
                post(`${result.ok ? '✅' : '❌'} Docker 验证完成，reward = ${result.reward}\n${result.output}\npatch: ${result.patchFile}`);
            }
            else {
                post(`❌ Docker 验证未完成：${result.error ?? ''}\n${result.output}`);
            }
        }
        catch (err) {
            post(`❌ Docker 验证出错：${err}`);
        }
        finally {
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
            const state = JSON.parse(fs.readFileSync(path.join(runDir, 'run-state.json'), 'utf8'));
            const files = fs.readdirSync(runDir).join(', ');
            provider.postPipelineEvent(`\n📂 历史运行 ${runId}\n` +
                `阶段: ${state.stage}，打回: ${state.retries ?? 0} 次${state.failedExperts?.length ? `，失败专家: ${state.failedExperts.join(', ')}` : ''}\n` +
                `验证结论: ${state.verifySummary ?? '（无）'}\n` +
                `工件文件: ${files}\n` +
                `目录: ${runDir}`);
        }
        catch (err) {
            provider.postPipelineEvent(`读取历史运行失败：${err}`);
        }
    };
    context.subscriptions.push(vscode.commands.registerCommand('codexSciDebug.probeDebug', async () => {
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
    }));
}
function deactivate() { }
//# sourceMappingURL=extension.js.map