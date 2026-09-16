#!/usr/bin/env node
/**
 * 无头运行多 Agent 探测流水线（复用 VS Code 扩展 out/ 编译产物，配置镜像 package.json 默认值）。
 *
 * 用法：
 *   node tools/run-pipeline.js <taskDir> [publicCommand]
 * 示例：
 *   node tools/run-pipeline.js /home/satoru/magis/task089-repo "python3 reproduce.py"
 *
 * 前置：
 *   1. 已执行 npx tsc -p . 生成 out/
 *   2. 各角色上游服务就绪（本地桥接 node tools/siliconflow-bridge.js、本地 Qwen 等）
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const props = pkg.contributes.configuration.properties;
const defaults = (key, fallback) => {
  const p = props[key];
  return p && p.default !== undefined ? p.default : fallback;
};

function resolveProvider(id, providers) {
  if (!id) return undefined;
  const p = providers[id];
  if (!p || !p.baseUrl) return undefined;
  return { id, name: p.name ?? id, baseUrl: p.baseUrl, wireApi: p.wireApi, envKey: p.envKey };
}

const taskDir = process.argv[2];
if (!taskDir) {
  console.error('用法: node tools/run-pipeline.js <taskDir> [publicCommand]');
  process.exit(1);
}
const workspaceRoot = path.resolve(taskDir);
if (!fs.existsSync(workspaceRoot)) {
  console.error(`任务目录不存在: ${workspaceRoot}`);
  process.exit(1);
}

const problemDesc = fs.readFileSync(path.join(workspaceRoot, 'problem_desc.txt'), 'utf8').trim();
const intakeOverridePath = path.join(workspaceRoot, 'intake.txt');
const intake = fs.existsSync(intakeOverridePath)
  ? fs.readFileSync(intakeOverridePath, 'utf8').trim()
  : (
    `用户（非专业程序员）报告的问题：\n${problemDesc}\n\n` +
    'public 复现脚本（python3 reproduce.py）目前可以跑通并生成报告，但解析出的激发态光谱数据在科学语义上与 ORCA 输出不一致；' +
    '请在 source/ 下修复解析器，使暴露的激发态光谱数据在所有 ORCA spectrum 变体下都保持科学正确性。'
  );

const providers = defaults('codexSciDebug.providers', {});
const options = {
  codexPath: defaults('codexSciDebug.codexPath', 'codex'),
  model: defaults('codexSciDebug.model', ''),
  sandbox: 'read-only',
  cwd: workspaceRoot,
  workspaceRoot,
  publicCommand: process.argv[3] || defaults('codexSciDebug.publicCommand', ''),
  maxRetries: defaults('codexSciDebug.maxRetries', 2),
  expertTimeoutMs: defaults('codexSciDebug.expertTimeoutMinutes', 20) * 60 * 1000,
  repairTimeoutMs: defaults('codexSciDebug.repairTimeoutMinutes', 60) * 60 * 1000,
  pythonPath: defaults('codexSciDebug.pythonPath', '') || undefined,
  artifactsRoot: path.join(workspaceRoot, '.codex-sci-debug', 'runs'),
  expertModels: defaults('codexSciDebug.expertModels', {}),
  repairModel: defaults('codexSciDebug.repairModel', ''),
  expertKeys: defaults('codexSciDebug.expertKeys', {}),
  repairKey: defaults('codexSciDebug.repairKey', ''),
  mentorModel: defaults('codexSciDebug.mentorModel', ''),
  mentorKey: defaults('codexSciDebug.mentorKey', ''),
  mentorProvider: resolveProvider(defaults('codexSciDebug.mentorProvider', ''), providers),
  mentorMaxRegenerations: defaults('codexSciDebug.mentorMaxRegenerations', 1),
  expertProviders: Object.fromEntries(
    Object.entries(defaults('codexSciDebug.expertProviders', {})).map(([role, pid]) => [role, resolveProvider(pid, providers)])
  ),
  expertKnowledge: defaults('codexSciDebug.expertKnowledge', {}),
  knowledgeDir: defaults('codexSciDebug.knowledgeDir', '') || undefined,
  repairProvider: resolveProvider(defaults('codexSciDebug.repairProvider', ''), providers)
};

const { runPipeline } = require(path.join(ROOT, 'out', 'orchestrator', 'orchestrator.js'));

const startedAt = Date.now();
runPipeline(intake, options, (event) => {
  const stamp = new Date().toISOString().slice(11, 19);
  const line =
    event.type === 'stage' ? `[${stamp}] STAGE ${event.stage}${event.detail ? `（${event.detail}）` : ''}`
    : event.type === 'expert' ? `[${stamp}] EXPERT ${event.role}: ${event.status}`
    : event.type === 'report' ? `[${stamp}] REPORT ${event.report.role}: ${event.report.probes.length} 探针 / ${event.report.exposure_paths.length} 暴露入口`
    : event.type === 'activity' ? `[${stamp}] ${event.text}`
    : event.type === 'retry' ? `[${stamp}] RETRY 第 ${event.round} 轮打回：${event.reason.slice(0, 300)}`
    : event.type === 'patch' ? `[${stamp}] PATCH r${event.round} 来源=${event.source}：已记录 ${event.path}`
    : event.type === 'mentor' ? `[${stamp}] MENTOR r${event.round}[选择=${event.choice ?? '—'}]：${event.verdict} — ${event.summary}`
    : event.type === 'finished' ? `[${stamp}] FINISHED ok=${event.ok}：${event.summary}`
    : `[${stamp}] ${JSON.stringify(event).slice(0, 300)}`;
  console.log(line);
}).then((state) => {
  const mins = ((Date.now() - startedAt) / 60000).toFixed(1);
  console.log(`\n=== 流水线结束：stage=${state.stage} ok=${state.stage === 'done'} 用时 ${mins} 分钟 ===`);
  console.log(`runId: ${state.runId}`);
  process.exit(state.stage === 'done' ? 0 : 2);
});
