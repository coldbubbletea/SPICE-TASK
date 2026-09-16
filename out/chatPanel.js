"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ChatViewProvider = void 0;
class ChatViewProvider {
    constructor(extensionUri, backend) {
        this.extensionUri = extensionUri;
        this.backend = backend;
        this.backend.onEvent = (event) => this.postEvent(event);
    }
    resolveWebviewView(webviewView) {
        this.view = webviewView;
        webviewView.webview.options = { enableScripts: true };
        webviewView.webview.html = this.getHtml();
        webviewView.webview.onDidReceiveMessage((msg) => {
            if (msg?.type === 'send' && typeof msg.text === 'string') {
                this.backend.send(msg.text);
            }
            else if (msg?.type === 'cancel') {
                this.backend.cancel();
            }
            else if (msg?.type === 'probeDebug' && typeof msg.text === 'string') {
                this.onProbeDebug?.(msg.text);
            }
            else if (msg?.type === 'dockerVerify') {
                this.onDockerVerify?.();
            }
            else if (msg?.type === 'historyReady') {
                this.postHistory();
            }
            else if (msg?.type === 'openRun' && typeof msg.runId === 'string') {
                this.onOpenRun?.(msg.runId);
            }
            else if (msg?.type === 'agentModels') {
                const expertModels = msg.expertModels && typeof msg.expertModels === 'object'
                    ? msg.expertModels
                    : {};
                const repairModel = typeof msg.repairModel === 'string' ? msg.repairModel : '';
                const mentorModel = typeof msg.mentorModel === 'string' ? msg.mentorModel : '';
                this.onAgentModels?.(expertModels, repairModel, mentorModel);
            }
            else if (msg?.type === 'agentModelsRequest') {
                this.postAgentModels();
            }
            else if (msg?.type === 'agentKeys') {
                const expertKeys = msg.expertKeys && typeof msg.expertKeys === 'object'
                    ? msg.expertKeys
                    : {};
                const repairKey = typeof msg.repairKey === 'string' ? msg.repairKey : '';
                const mentorKey = typeof msg.mentorKey === 'string' ? msg.mentorKey : '';
                this.onAgentKeys?.(expertKeys, repairKey, mentorKey);
            }
            else if (msg?.type === 'agentKeysRequest') {
                this.postAgentKeys();
            }
            else if (msg?.type === 'knowledgeDir') {
                this.onKnowledgeDir?.(typeof msg.dir === 'string' ? msg.dir : '');
            }
            else if (msg?.type === 'knowledgeDirRequest') {
                this.postKnowledgeDir();
            }
        });
    }
    postAgentModels() {
        const models = this.initialAgentModels?.();
        if (models) {
            this.view?.webview.postMessage({
                type: 'agentModels',
                roles: models.roles,
                expertModels: models.expertModels,
                repairModel: models.repairModel,
                mentorModel: models.mentorModel ?? ''
            });
        }
    }
    postAgentKeys() {
        const keys = this.initialAgentKeys?.();
        if (keys) {
            this.view?.webview.postMessage({
                type: 'agentKeys',
                roles: keys.roles,
                expertKeys: keys.expertKeys,
                repairKey: keys.repairKey,
                mentorKey: keys.mentorKey ?? ''
            });
        }
    }
    postKnowledgeDir() {
        const dir = this.initialKnowledgeDir?.() ?? '';
        this.view?.webview.postMessage({
            type: 'knowledgeDir',
            dir: dir
        });
    }
    postHistory(items) {
        const runs = items ?? this.onHistoryRequest?.() ?? [];
        this.view?.webview.postMessage({ type: 'history', runs });
    }
    sendUserMessage(text) {
        this.view?.webview.postMessage({ type: 'userMessage', text });
        this.backend.send(text);
    }
    postPipelineEvent(text) {
        this.view?.webview.postMessage({ type: 'backendEvent', event: { type: 'text', text: text + '\n' } });
    }
    postPipelineUi(payload) {
        this.view?.webview.postMessage({ type: 'pipeline', payload });
    }
    reveal() {
        this.view?.show?.(true);
    }
    postEvent(event) {
        this.view?.webview.postMessage({ type: 'backendEvent', event });
    }
    getHtml() {
        const nonce = String(Date.now());
        return /* html */ `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  :root {
    color-scheme: light dark;
    --bg: var(--vscode-sideBar-background, #1e1e1e);
    --panel: var(--vscode-editorWidget-background, #252526);
    --line: var(--vscode-panel-border, #3c3c3c);
    --fg: var(--vscode-foreground, #cccccc);
    --muted: var(--vscode-descriptionForeground, #9e9e9e);
    --accent: var(--vscode-button-background, #0a84d0);
    --accent-hover: var(--vscode-button-hoverBackground, #1193e3);
    --accent-fg: var(--vscode-button-foreground, #ffffff);
    --ok: var(--vscode-charts-green, #4ec9b0);
    --warn: var(--vscode-charts-yellow, #cca700);
    --err: var(--vscode-errorForeground, #f48771);
    --code-bg: var(--vscode-textCodeBlock-background, #1e1e1e);
    --user-bubble: var(--vscode-editor-inactiveSelectionBackground, #2a2d2e);
    --hover: var(--vscode-list-hoverBackground, #2a2d2e);
    --radius: 8px;
    --shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
    --font-mono: var(--vscode-editor-font-family, monospace);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; height: 100vh; display: flex; flex-direction: column;
    font-family: var(--vscode-font-family, sans-serif);
    font-size: var(--vscode-font-size, 13px);
    color: var(--fg); background: var(--bg);
  }
  ::-webkit-scrollbar { width: 8px; height: 8px; }
  ::-webkit-scrollbar-thumb { background: rgba(128, 128, 128, 0.35); border-radius: 4px; }
  ::-webkit-scrollbar-track { background: transparent; }
  /* ---- 顶部标题栏 ---- */
  #header {
    display: flex; align-items: center; gap: 8px;
    padding: 8px 12px;
    background: linear-gradient(135deg, rgba(10, 132, 208, 0.14), rgba(78, 201, 176, 0.1));
    border-bottom: 1px solid var(--line);
  }
  #header .logo {
    display: flex; align-items: center; justify-content: center;
    width: 26px; height: 26px; border-radius: 8px;
    background: linear-gradient(135deg, #0a84d0, #4ec9b0);
    font-size: 14px; box-shadow: var(--shadow);
  }
  #header .title { font-weight: 600; font-size: 0.92em; }
  #status {
    margin-left: auto; display: flex; align-items: center; gap: 6px;
    font-size: 0.78em; color: var(--muted);
  }
  #statusDot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: 0 0 8px; }
  #status.running #statusDot { background: var(--warn); animation: pulse 1.2s ease-in-out infinite; }
  #status.running #statusText { color: var(--warn); }
  #status.error #statusDot { background: var(--err); }
  #status.error #statusText { color: var(--err); }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
  /* ---- 可折叠区块（历史 / 模型分配 / 密钥分配）---- */
  #history, #modelPicker, #keyPicker, #knowledgeDirPicker { border-bottom: 1px solid var(--line); background: var(--panel); }
  #history summary, #modelPicker summary, #keyPicker summary, #knowledgeDirPicker summary {
    padding: 8px 12px; cursor: pointer; font-size: 0.82em;
    color: var(--muted); user-select: none; list-style: none;
    display: flex; align-items: center; gap: 6px;
  }
  #history summary::-webkit-details-marker, #modelPicker summary::-webkit-details-marker, #keyPicker summary::-webkit-details-marker, #knowledgeDirPicker summary::-webkit-details-marker { display: none; }
  #history summary::before, #modelPicker summary::before, #keyPicker summary::before, #knowledgeDirPicker summary::before {
    content: '▸'; font-size: 0.85em; transition: transform 0.15s ease;
  }
  #history[open] summary::before, #modelPicker[open] summary::before, #keyPicker[open] summary::before, #knowledgeDirPicker[open] summary::before { transform: rotate(90deg); }
  #historyList { max-height: 140px; overflow-y: auto; padding: 2px 12px 8px; display: flex; flex-direction: column; gap: 2px; }
  .run-item {
    display: flex; align-items: center; gap: 6px;
    padding: 5px 8px; border-radius: 6px; cursor: pointer;
    font-size: 0.8em; white-space: nowrap; overflow: hidden;
    text-overflow: ellipsis; border: 1px solid transparent;
    transition: background 0.12s ease, border-color 0.12s ease;
  }
  .run-item:hover { background: var(--hover); border-color: var(--line); }
  .run-item .ok { color: var(--ok); }
  .run-item .fail { color: var(--err); }
  .run-item .pending { color: var(--warn); }
  #modelRows, #keyRows { padding: 4px 12px 10px; display: flex; flex-direction: column; gap: 6px; }
  .key-hint { margin: 0 12px 8px; font-size: 11px; line-height: 1.5; color: var(--fg-dim, #888); }
  .model-row { display: flex; align-items: center; gap: 8px; font-size: 0.8em; }
  .model-row label {
    flex: 0 0 108px; color: var(--muted);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .model-row input {
    flex: 1; min-width: 0; padding: 5px 8px;
    color: var(--fg); background: var(--vscode-input-background, #3c3c3c);
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: 6px; font-family: var(--font-mono); font-size: 0.95em;
    outline: none; transition: border-color 0.12s ease;
  }
  .model-row input:focus { border-color: var(--accent); }
  .key-row .key-toggle { padding: 0 4px; font-size: 13px; flex: 0 0 auto; }
  /* ---- 消息流 ---- */
  #messages { flex: 1; overflow-y: auto; padding: 12px; display: flex; flex-direction: column; gap: 10px; }
  .msg {
    display: flex; gap: 8px; max-width: 94%;
    animation: msgIn 0.18s ease-out;
  }
  @keyframes msgIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
  .msg .avatar {
    flex: 0 0 26px; width: 26px; height: 26px; border-radius: 8px;
    display: flex; align-items: center; justify-content: center;
    font-size: 13px; background: var(--panel);
    border: 1px solid var(--line); box-shadow: var(--shadow);
  }
  .msg .bubble {
    min-width: 0; padding: 8px 12px; border-radius: 10px;
    white-space: pre-wrap; word-break: break-word;
    background: var(--panel); border: 1px solid var(--line);
    box-shadow: var(--shadow);
  }
  .bubble > code {
    font-family: var(--font-mono); font-size: 0.92em;
    background: rgba(128, 128, 128, 0.18);
    padding: 1px 5px; border-radius: 4px;
  }
  .bubble pre {
    background: var(--code-bg); border: 1px solid var(--line);
    border-radius: 6px; padding: 8px 10px; overflow-x: auto;
    font-family: var(--font-mono); font-size: 0.85em;
    margin: 6px 0; white-space: pre;
  }
  .msg.user { align-self: flex-end; flex-direction: row-reverse; }
  .msg.user .avatar { background: linear-gradient(135deg, #0a84d0, #4ec9b0); border: none; color: #fff; }
  .msg.user .bubble {
    background: var(--user-bubble); border-color: transparent;
    border-bottom-right-radius: 4px;
  }
  .msg.agent .avatar { background: linear-gradient(135deg, #6f42c1, #0a84d0); border: none; }
  .msg.agent .bubble { border-bottom-left-radius: 4px; }
  .msg.command { align-self: stretch; max-width: 100%; }
  .msg.command .avatar { background: var(--code-bg); }
  .msg.command .bubble {
    font-family: var(--font-mono); font-size: 0.85em;
    background: var(--code-bg); border-left: 3px solid var(--accent);
  }
  .msg.error .avatar { background: var(--err); color: #fff; }
  .msg.error .bubble { border-color: rgba(244, 135, 113, 0.4); color: var(--err); }
  /* ---- 流水线状态卡 ---- */
  #pipelineCard {
    margin: 0 12px; padding: 12px; border-radius: var(--radius);
    background: var(--panel); border: 1px solid var(--line);
    box-shadow: var(--shadow);
    animation: msgIn 0.2s ease-out;
  }
  #pipelineCard.hidden { display: none; }
  .timeline { display: flex; align-items: center; }
  .stage {
    display: flex; align-items: center; gap: 5px;
    font-size: 0.78em; opacity: 0.4; font-weight: 500;
    transition: opacity 0.15s ease;
  }
  .stage .dot {
    width: 10px; height: 10px; border-radius: 50%;
    background: var(--muted); flex: 0 0 10px;
  }
  .stage.active { opacity: 1; color: var(--warn); }
  .stage.active .dot {
    background: var(--warn);
    animation: pulse 1.2s ease-in-out infinite;
    box-shadow: 0 0 6px var(--warn);
  }
  .stage.done { opacity: 1; }
  .stage.done .dot { background: var(--ok); }
  .stage.done .dot::after { content: '✓'; position: relative; top: -10px; left: -11px; color: var(--ok); font-size: 0.7em; }
  .stage.failed { opacity: 1; color: var(--err); }
  .stage.failed .dot { background: var(--err); }
  .timeline .connector { flex: 1; height: 2px; background: var(--line); margin: 0 8px; min-width: 12px; }
  .experts { display: flex; gap: 6px; margin-top: 10px; flex-wrap: wrap; }
  .chip {
    display: none; align-items: center; gap: 6px;
    font-size: 0.78em; padding: 3px 10px; border-radius: 999px;
    background: var(--user-bubble); border: 1px solid var(--line);
  }
  .chip.show { display: inline-flex; animation: msgIn 0.18s ease-out; }
  .chip .dot { width: 7px; height: 7px; border-radius: 50%; flex: 0 0 7px; }
  .chip.running .dot { background: var(--warn); animation: pulse 1s infinite; }
  .chip.done .dot { background: var(--ok); }
  .chip.failed .dot { background: var(--err); }
  #timer { margin-top: 10px; font-size: 0.75em; color: var(--muted); font-variant-numeric: tabular-nums; }
  #banner {
    margin-top: 10px; padding: 8px 10px; border-radius: 6px;
    font-size: 0.85em; font-weight: 600; display: none;
  }
  #banner.ok { display: block; color: var(--ok); background: rgba(78, 201, 176, 0.12); }
  #banner.fail { display: block; color: var(--err); background: rgba(244, 135, 113, 0.12); }
  /* ---- 输入区 ---- */
  #inputRow {
    display: flex; gap: 8px; padding: 10px 12px;
    border-top: 1px solid var(--line);
    background: var(--panel);
  }
  #input {
    flex: 1; resize: none; min-height: 36px; max-height: 120px;
    font-family: inherit; font-size: inherit; line-height: 1.4;
    color: var(--fg); background: var(--vscode-input-background, #3c3c3c);
    border: 1px solid var(--vscode-input-border, #3c3c3c);
    border-radius: var(--radius); padding: 8px 10px;
    outline: none; transition: border-color 0.12s ease;
  }
  #input:focus { border-color: var(--accent); }
  .composer { display: flex; gap: 6px; align-items: center; }
  button {
    color: var(--accent-fg);
    background: var(--accent);
    border: none; border-radius: var(--radius);
    padding: 0 14px; min-height: 36px;
    font-size: 0.85em; font-weight: 600; cursor: pointer;
    transition: background 0.12s ease, opacity 0.12s ease;
  }
  button:hover:not(:disabled) { background: var(--accent-hover); }
  button:disabled { opacity: 0.45; cursor: default; }
  .icon-btn {
    background: transparent; padding: 0 8px; font-size: 15px; font-weight: 400;
    color: var(--fg); opacity: 0.8;
  }
  .icon-btn:hover:not(:disabled) { background: var(--hover); opacity: 1; }
  .icon-btn:disabled { opacity: 0.35; }
</style>
</head>
<body>
  <header id="header">
    <div class="logo">🧬</div>
    <div class="title">Codex Sci Debug</div>
    <div id="status" class="idle">
      <span id="statusDot"></span><span id="statusText">空闲</span>
    </div>
  </header>
  <details id="history">
    <summary>📂 历史记录（<span id="historyCount">0</span>）</summary>
    <div id="historyList"></div>
  </details>
  <details id="modelPicker">
    <summary>🎛 模型分配（留空 = 使用全局默认模型）</summary>
    <div id="modelRows"></div>
  </details>
  <details id="keyPicker">
    <summary>🔑 密钥分配（留空 = 使用全局登录凭证）</summary>
    <div id="keyRows"></div>
    <div class="key-hint">🧬 SciProber 默认使用 DeepSeek 提供商（模型 deepseek-v4-pro，OpenAI 兼容端点 https://api.deepseek.com，key 已默认填入）；SciPatcher-sci（domain-invariant）默认使用本地 Qwen（local-qwen，http://localhost:8040/v1，本地服务无需 key）；SciReviewer 默认使用 Moonshot（moonshot，模型 kimi-k3，https://api.moonshot.cn/v1，key 已默认填入）；SciPatcher-general 默认 SiliconFlow GLM-5.2（zai-org/GLM-5.2，经本地桥接 node tools/siliconflow-bridge.js，端口 8050，envKey=SILICONFLOW_API_KEY，key 已默认填入）；留空则用全局凭证。请在此填入对应 API key，密钥会按该提供商的 envKey 环境变量注入会话；提供商与 envKey 可在设置 codexSciDebug.providers 中调整。</div>
  </details>
  <details id="knowledgeDirPicker">
    <summary>📚 领域知识目录（SciPatcher-sci）</summary>
    <div class="model-row" style="padding: 4px 12px;">
      <label>知识目录</label>
      <input id="knowledgeDirInput" placeholder=".codex-sci-debug/knowledge/（留空 = 仅用内置清单）">
    </div>
    <div class="key-hint">SciPatcher-sci 在只读沙箱中运行，开始前会先阅读该目录（相对 workspace）下的领域知识文档；具体文件内容不注入 prompt，仅注入一行指引。内置不变量清单可通过设置 codexSciDebug.expertKnowledge 调整。</div>
  </details>
  <div id="pipelineCard" class="hidden">
    <div class="stages" id="stages"></div>
    <div class="experts" id="experts"></div>
    <div id="timer"></div>
    <div id="banner"></div>
  </div>
  <div id="messages"></div>
  <div id="inputRow">
    <textarea id="input" rows="1" placeholder="描述问题或粘贴报错…  (Ctrl+Enter 发送)"></textarea>
    <div class="composer">
      <button id="probeBtn" class="icon-btn" title="启动多 Agent 探测修复流水线">🔬</button>
      <button id="dockerBtn" class="icon-btn" title="一键在 Docker 中跑原生 verifier 评分">🐳</button>
      <button id="cancelBtn" class="icon-btn" title="停止" disabled>⏹</button>
      <button id="sendBtn">发送</button>
    </div>
  </div>
<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  const messagesEl = document.getElementById('messages');
  const statusEl = document.getElementById('status');
  const statusText = document.getElementById('statusText');
  const inputEl = document.getElementById('input');
  const sendBtn = document.getElementById('sendBtn');
  const cancelBtn = document.getElementById('cancelBtn');
  let currentAgentEl = null;

  const AVATARS = { user: '🧑', agent: '🤖', command: '💻', error: '⚠️' };
  function setStatus(state) {
    statusEl.className = state;
    statusText.textContent = state === 'running' ? '运行中…' : state === 'error' ? '出错' : '空闲';
    cancelBtn.disabled = state !== 'running';
    sendBtn.disabled = state === 'running';
  }
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function renderInlineMd(s) {
    return escapeHtml(s)
      .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }
  function renderMd(text) {
    const parts = String(text).split(/\`\`\`/);
    let html = '';
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 0) {
        html += renderInlineMd(parts[i]);
      } else {
        const code = parts[i].replace(/^\\n/, '');
        html += '<pre>' + escapeHtml(code) + '</pre>';
      }
    }
    return html;
  }
  function addMsg(cls, text) {
    const el = document.createElement('div');
    el.className = 'msg ' + cls;
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.textContent = AVATARS[cls] || '';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    if (cls === 'command') {
      bubble.textContent = text;
    } else {
      bubble.dataset.raw = text;
      bubble.innerHTML = renderMd(text);
    }
    el.appendChild(avatar);
    el.appendChild(bubble);
    messagesEl.appendChild(el);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return bubble;
  }
  function handleEvent(ev) {
    if (ev.type === 'text') {
      if (!currentAgentEl) currentAgentEl = addMsg('agent', '');
      currentAgentEl.dataset.raw += ev.text;
      currentAgentEl.innerHTML = renderMd(currentAgentEl.dataset.raw);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else if (ev.type === 'command') {
      currentAgentEl = null;
      addMsg('command', '$ ' + ev.command + (ev.exitCode !== undefined ? '  [exit ' + ev.exitCode + ']' : ''));
    } else if (ev.type === 'error') {
      currentAgentEl = null;
      addMsg('error', ev.message);
    } else if (ev.type === 'status') {
      if (ev.status !== 'running') currentAgentEl = null;
      setStatus(ev.status);
    }
  }
  function send() {
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    currentAgentEl = null;
    addMsg('user', text);
    vscode.postMessage({ type: 'send', text });
  }
  sendBtn.addEventListener('click', send);
  cancelBtn.addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
  document.getElementById('probeBtn').addEventListener('click', () => {
    const text = inputEl.value.trim();
    if (!text) { inputEl.placeholder = '先描述你的问题，再点 🔬'; inputEl.focus(); return; }
    inputEl.value = '';
    currentAgentEl = null;
    addMsg('user', text);
    vscode.postMessage({ type: 'probeDebug', text });
  });
  document.getElementById('dockerBtn').addEventListener('click', () => {
    vscode.postMessage({ type: 'dockerVerify' });
  });
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
  });
  window.addEventListener('message', (e) => {
    const msg = e.data;
    if (msg.type === 'backendEvent') handleEvent(msg.event);
    else if (msg.type === 'userMessage') { currentAgentEl = null; addMsg('user', msg.text); }
    else if (msg.type === 'pipeline') handlePipeline(msg.payload);
    else if (msg.type === 'history') renderHistory(msg.runs);
    else if (msg.type === 'agentModels') renderModelRows(msg);
    else if (msg.type === 'agentKeys') renderKeyRows(msg);
    else if (msg.type === 'knowledgeDir') renderKnowledgeDir(msg);
  });
  setStatus('idle');
  vscode.postMessage({ type: 'historyReady' });
  vscode.postMessage({ type: 'agentModelsRequest' });
  vscode.postMessage({ type: 'agentKeysRequest' });
  vscode.postMessage({ type: 'knowledgeDirRequest' });
  document.getElementById('knowledgeDirInput')?.addEventListener('change', postKnowledgeDirFromUi);

  /* ---- 模型分配 UI ---- */
  const ROLE_LABELS = {
    'tester': 'SciProber',
    'domain-invariant': 'SciPatcher (sci)',
    'repair': 'SciPatcher (general)',
    'mentor': 'SciReviewer'
  };
  function renderModelRows(payload) {
    const container = document.getElementById('modelRows');
    container.innerHTML = '';
    const expertModels = payload.expertModels || {};
    const roles = (payload.roles && payload.roles.length) ? payload.roles : Object.keys(expertModels);
    for (const role of roles) {
      container.appendChild(makeModelRow(role, ROLE_LABELS[role] || role, expertModels[role] || ''));
    }
    container.appendChild(makeModelRow('repair', ROLE_LABELS.repair, payload.repairModel || ''));
    container.appendChild(makeModelRow('mentor', ROLE_LABELS.mentor, payload.mentorModel || ''));
  }
  function makeModelRow(role, label, value) {
    const row = document.createElement('div');
    row.className = 'model-row';
    const lab = document.createElement('label');
    lab.textContent = label;
    lab.title = role;
    const input = document.createElement('input');
    input.placeholder = '（默认）';
    input.value = value;
    input.dataset.role = role;
    input.addEventListener('change', postAgentModelsFromUi);
    row.appendChild(lab);
    row.appendChild(input);
    return row;
  }
  function postAgentModelsFromUi() {
    const expertModels = {};
    let repairModel = '';
    let mentorModel = '';
    document.querySelectorAll('#modelRows .model-row input').forEach((inp) => {
      const value = inp.value.trim();
      if (inp.dataset.role === 'repair') {
        repairModel = value;
      } else if (inp.dataset.role === 'mentor') {
        mentorModel = value;
      } else if (value) {
        expertModels[inp.dataset.role] = value;
      }
    });
    vscode.postMessage({ type: 'agentModels', expertModels, repairModel, mentorModel });
  }

  /* ---- 密钥分配 UI ---- */
  function renderKeyRows(payload) {
    const container = document.getElementById('keyRows');
    container.innerHTML = '';
    const expertKeys = payload.expertKeys || {};
    const roles = (payload.roles && payload.roles.length) ? payload.roles : Object.keys(expertKeys);
    for (const role of roles) {
      container.appendChild(makeKeyRow(role, ROLE_LABELS[role] || role, expertKeys[role] || ''));
    }
    container.appendChild(makeKeyRow('repair', ROLE_LABELS.repair, payload.repairKey || ''));
    container.appendChild(makeKeyRow('mentor', ROLE_LABELS.mentor, payload.mentorKey || ''));
  }
  function makeKeyRow(role, label, value) {
    const row = document.createElement('div');
    row.className = 'model-row key-row';
    const lab = document.createElement('label');
    lab.textContent = label;
    lab.title = role;
    const input = document.createElement('input');
    input.type = 'password';
    input.placeholder = '（全局凭证）';
    input.value = value;
    input.dataset.role = role;
    input.autocomplete = 'off';
    input.addEventListener('change', postAgentKeysFromUi);
    const toggle = document.createElement('button');
    toggle.className = 'icon-btn key-toggle';
    toggle.type = 'button';
    toggle.textContent = '👁';
    toggle.title = '显示 / 隐藏';
    toggle.addEventListener('click', () => {
      input.type = input.type === 'password' ? 'text' : 'password';
    });
    row.appendChild(lab);
    row.appendChild(input);
    row.appendChild(toggle);
    return row;
  }
  function postAgentKeysFromUi() {
    const expertKeys = {};
    let repairKey = '';
    let mentorKey = '';
    document.querySelectorAll('#keyRows .key-row input').forEach((inp) => {
      const value = inp.value.trim();
      if (inp.dataset.role === 'repair') {
        repairKey = value;
      } else if (inp.dataset.role === 'mentor') {
        mentorKey = value;
      } else if (value) {
        expertKeys[inp.dataset.role] = value;
      }
    });
    vscode.postMessage({ type: 'agentKeys', expertKeys, repairKey, mentorKey });
  }

  /* ---- 知识目录 UI ---- */
  function renderKnowledgeDir(payload) {
    const input = document.getElementById('knowledgeDirInput');
    if (input) input.value = payload.dir || '';
  }
  function postKnowledgeDirFromUi() {
    const input = document.getElementById('knowledgeDirInput');
    vscode.postMessage({ type: 'knowledgeDir', dir: input ? input.value.trim() : '' });
  }

  function renderHistory(runs) {
    const list = document.getElementById('historyList');
    document.getElementById('historyCount').textContent = runs.length;
    list.innerHTML = '';
    for (const run of runs) {
      const el = document.createElement('div');
      el.className = 'run-item';
      const icon = run.ok === true ? '<span class="ok">✅</span>' : run.ok === false ? '<span class="fail">❌</span>' : '<span class="pending">⏳</span>';
      el.innerHTML = icon + ' ' + run.time + ' — ' + (run.summary || '').replace(/[<>&]/g, '');
      el.title = run.runId;
      el.addEventListener('click', () => vscode.postMessage({ type: 'openRun', runId: run.runId }));
      list.appendChild(el);
    }
    if (!runs.length) {
      list.innerHTML = '<div class="run-item" style="cursor:default;opacity:0.6">暂无历史运行</div>';
    }
  }

  /* ---- pipeline 状态卡 ---- */
  const STAGES = ['probe', 'repair', 'verify', 'mentor', 'done'];
  const STAGE_LABEL = { probe: '🔍 探测', repair: '🔧 修复', verify: '🧪 验证', mentor: '⚖️ SciReviewer 评审', done: '🏁 完成' };
  const cardEl = document.getElementById('pipelineCard');
  const stagesEl = document.getElementById('stages');
  const expertsEl = document.getElementById('experts');
  const timerEl = document.getElementById('timer');
  const bannerEl = document.getElementById('banner');
  let timerStart = 0, timerHandle = null;
  const stageEls = {};
  const expertEls = {};

  function fmtElapsed(ms) {
    const s = Math.floor(ms / 1000);
    return Math.floor(s / 60) + ' 分 ' + (s % 60) + ' 秒';
  }
  function startTimer() {
    timerStart = Date.now();
    stopTimer();
    timerHandle = setInterval(() => { timerEl.textContent = '已运行 ' + fmtElapsed(Date.now() - timerStart); }, 1000);
    timerEl.textContent = '已运行 0 分 0 秒';
  }
  function stopTimer() { if (timerHandle) { clearInterval(timerHandle); timerHandle = null; } }

  function handlePipeline(p) {
    if (!p) return;
    if (p.action === 'start') {
      cardEl.classList.remove('hidden');
      stagesEl.innerHTML = ''; expertsEl.innerHTML = '';
      bannerEl.className = ''; bannerEl.textContent = '';
      for (const k of Object.keys(expertEls)) delete expertEls[k];
      STAGES.forEach((s, i) => {
        const el = document.createElement('span');
        el.className = 'stage'; el.textContent = STAGE_LABEL[s];
        stagesEl.appendChild(el);
        if (i < STAGES.length - 1) {
          const arrow = document.createElement('span');
          arrow.className = 'stage arrow'; arrow.textContent = '→';
          stagesEl.appendChild(arrow);
        }
        stageEls[s] = el;
      });
      setStageActive('probe');
      startTimer();
    } else if (p.action === 'stage') {
      if (p.stage === 'repair' || p.stage === 'verify') {
        if (stageEls.repair.classList.contains('active')) setStageActive('verify');
        else setStageActive('repair');
      } else if (p.stage === 'mentor') {
        setStageActive('mentor');
      }
    } else if (p.action === 'expert') {
      let chip = expertEls[p.role];
      if (!chip) {
        chip = document.createElement('span');
        chip.className = 'chip show';
        chip.innerHTML = '<span class="dot"></span><span class="label"></span>';
        expertsEl.appendChild(chip);
        expertEls[p.role] = chip;
      }
      chip.classList.remove('running', 'done', 'failed');
      chip.classList.add(p.status === 'started' ? 'running' : p.status);
      const icon = p.status === 'done' ? ' ✓' : p.status === 'failed' ? ' ✗' : '';
      chip.querySelector('.label').textContent = p.role + icon;
    } else if (p.action === 'retry') {
      setStageActive('repair');
      for (const k of ['verify', 'mentor']) { stageEls[k].className = 'stage'; }
      timerEl.textContent = '已运行 ' + fmtElapsed(Date.now() - timerStart) + ' · 第 ' + p.round + ' 次打回重修';
    } else if (p.action === 'mentor') {
      const icon = p.verdict === 'accept' ? '✅' : p.verdict === 'regenerate' ? '⚠️' : '❓';
      bannerEl.className = p.verdict === 'regenerate' ? 'fail' : '';
      bannerEl.textContent = icon + ' ' + p.summary;
    } else if (p.action === 'finished') {
      stopTimer();
      for (const s of STAGES) stageEls[s].classList.remove('active');
      if (p.ok) {
        markAllDone();
        bannerEl.className = 'ok';
        bannerEl.textContent = '✅ ' + p.summary + '（耗时 ' + fmtElapsed(Date.now() - timerStart) + '）';
      } else {
        const active = STAGES.find(s => stageEls[s].classList.contains('active')) || 'verify';
        stageEls[active].classList.add('failed');
        bannerEl.className = 'fail';
        bannerEl.textContent = '❌ ' + p.summary;
      }
    }
  }
  function setStageActive(name) {
    const idx = STAGES.indexOf(name);
    STAGES.forEach((s, i) => {
      stageEls[s].classList.remove('active', 'done', 'failed');
      if (i < idx) stageEls[s].classList.add('done');
      if (i === idx) stageEls[s].classList.add('active');
    });
  }
  function markAllDone() {
    STAGES.forEach(s => { stageEls[s].className = 'stage done'; });
  }
</script>
</body>
</html>`;
    }
}
exports.ChatViewProvider = ChatViewProvider;
ChatViewProvider.viewType = 'codexSciDebug.chatView';
//# sourceMappingURL=chatPanel.js.map