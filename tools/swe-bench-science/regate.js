#!/usr/bin/env node
// 仅重跑「本底判别诊断」（确定性，无 LLM 调用）：用于 harness 修复后原地重算既有探针套件的诊断信号。
// 用法: node tools/swe-bench-science/regate.js <runDir> <workspaceRoot>
const fs = require('fs');
const path = require('path');
const { runProbeBaselineGate } = require(path.join(__dirname, '..', '..', 'out', 'orchestrator', 'verifier.js'));

(async () => {
  const runDir = path.resolve(process.argv[2] || '');
  const ws = path.resolve(process.argv[3] || '');
  if (!runDir || !ws) throw new Error('usage: regate.js <runDir> <workspaceRoot>');
  const manifest = JSON.parse(fs.readFileSync(path.join(runDir, 'probes', 'manifest.json'), 'utf8'));
  const probes = manifest.probes.map((e) => ({
    id: e.id,
    title: e.title,
    kind: e.kind || 'python',
    dimension: e.dimension,
    expect: e.expect,
    code: fs.readFileSync(path.join(runDir, 'probes', e.file), 'utf8'),
    patcher_guidance: e.patcher_guidance,
    rank: e.rank,
    kill_line: e.kill_line,
    falsifier: e.falsifier,
    alt_sites: e.alt_sites
  }));
  const gate = await runProbeBaselineGate(ws, probes, path.join(runDir, 'baseline-gate', 'regate'), undefined);
  const out = path.join(runDir, 'baseline-gate', 'probe-baseline-gate-regate.json');
  fs.writeFileSync(out, JSON.stringify(gate, null, 2));
  console.log(JSON.stringify({ ok: gate.ok, executed: gate.executed, reason: gate.reason, summary: gate.summary, discriminating: gate.discriminating, low_signal: gate.low_signal_probes }, null, 2));
  console.log('written:', out);
})().catch((e) => { console.error(e); process.exit(1); });
