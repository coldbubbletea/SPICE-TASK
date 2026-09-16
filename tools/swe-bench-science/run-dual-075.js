#!/usr/bin/env node
/**
 * dual-debugger-mentor 流水线的 headless 入口（无需 VS Code）。
 *
 * 用法:
 *   node tools/swe-bench-science/run-dual-075.js [--workspace <task 工作目录>] [--max-retries 1]
 *   node tools/swe-bench-science/run-dual-075.js --role prober  [--workspace <dir>]
 *     只跑 SciProber（probe）：新建 run 目录，物化 probes/ 后停下（stage=probe-done）
 *   node tools/swe-bench-science/run-dual-075.js --role patcher [--run-dir <runDir>] [--workspace <dir>] [--repair-timeout-min <n>]
 *     只跑 SciPatcher（三候选 patch + verify）：复用已有 run 目录（缺省取最新），停下（stage=patcher-done）
 *     --repair-timeout-min <n>: patcher 限时交卷分钟数（默认 20；放宽如 60 = 一小时，patcher 需先自跑
 *     verify/probes/ 探针再据结果修改；★ 2026-09-16：探针与 prober 的 patcher_guidance
 *     都是「可错的一家之言」，须独立核实并逐条给处置（采纳/驳回/存疑）+ 自己的依据，
 *     不是验收门禁。见 shots/patcher_skill.md §6.1/§27 与 流程.md §3.3）
 *   --only-roles <channels>: 只启用指定通道（逗号分隔: ds, kimi, sci, general）
 *     prober 侧 ds→tester(deepseek-v4-pro)、kimi→kimi-k3；patcher 侧 ds→ds、sci→本地 qwen、general→GLM
 *     例: --only-roles ds = 仅跑 deepseek 通道；未启用通道全部跳过（skipped 占位，不阻塞），
 *     配置 fail-fast 校验范围随之收窄（未启用通道的 key 不再要求）
 *   node tools/swe-bench-science/run-dual-075.js --role mentor  [--run-dir <runDir>] [--workspace <dir>]
 *     只跑 SciReviewer（打分→打磨→终审）：复用同一 run 目录；不再生成、不从零自写
 *   node tools/swe-bench-science/run-dual-075.js --from-run <runDir>   # 断点续跑：
 *     复用 <runDir>（某次 run 的产物目录，含 probe-report-*.json 与 patch-r1-*.diff）的
 *     探针报告与三候选 diff，跳过 probe/repair，直接从 SciReviewer 终审开始（非阻塞：
 *     候选即使不可用也会全部喂给 SciReviewer）。
 *
 * 不传 --workspace 时自动使用 /tmp 下最新的 swe-075-workspace-* 目录。
 *
 * 角色→模型/提供商/密钥 统一由 --config 指定的 075.json 提供（默认 swe-bench-sci/075.json，
 * 内容固化自 package.json 的 codexSciDebug.* 默认值）；缺 key 启动即失败（fail-fast）。
 * 工件落 <workspace>/.codex-sci-debug/runs/<runId>/。
 *
 * 强制角色 API 配置（openspec 规定；对照表详见仓库根 README-swe-bench-sci.md）:
 * ★ 2026-09-14 硬改：所有角色统一 Claude Code harness（providers.deepseek.harness=claude）
 *   + deepseek-v4-pro + 思维强度 max（providers.deepseek.effort=max → claude --effort max），
 *   端点走 providers.deepseek.claudeBaseUrl=https://api.deepseek.com/anthropic（Anthropic 兼容），
 *   key 取 roles.<role>.key / DEEPSEEK_API_KEY（env 优先）。codex CLI 不再使用；
 *   本地 Qwen :8040 与 SiliconFlow 桥 :8050 不再需要。
 * 角色（tester / kimi / domain-invariant / repair / ds / mentor）:
 *   prober 侧（tester/kimi）→ ds flash：deepseek-chat + medium（providers.deepseek-flash，2026-09-15 起）；
 *   patcher 侧（domain-invariant/repair/ds）与 mentor → Claude Code（host claude CLI，~/.npm-global/bin/claude）+ deepseek-v4-pro + thinking max
 */
const path = require('path');
const fs = require('fs');
const { runPipeline } = require('../../out/orchestrator/orchestrator');

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

/** 角色 → 提供商解析：返回带 id 的 ModelProviderConfig（codex -c model_provider=<id> / claude harness 需要 id）。 */
function providerFor(cfg, name) {
  const p = cfg.providers?.[name];
  if (!p) {
    throw new Error(`075.json 缺少提供商定义: ${name}`);
  }
  return { id: p.id ?? name, name: p.name ?? name, baseUrl: p.baseUrl, wireApi: p.wireApi ?? 'responses', envKey: p.envKey, reasoningEffort: p.reasoningEffort, harness: p.harness, claudeBaseUrl: p.claudeBaseUrl, effort: p.effort ?? p.reasoningEffort, maxBudgetUsd: p.maxBudgetUsd, claudeSettings: p.claudeSettings };
}

/** 角色 key 解析顺序：进程环境变量（provider.envKey）> 075.json roles.<role>.key。缺失即抛出。 */
function keyFor(cfg, role) {
  const r = cfg.roles?.[role];
  const prov = r ? cfg.providers?.[r.provider] : undefined;
  const envName = prov?.envKey || (r?.keyEnv ? cfg.providers?.[r.provider]?.envKey : undefined) || r?.keyEnv;
  if (envName && process.env[envName]) return process.env[envName];
  if (r?.key) return r.key;
  const envVal = envName ? process.env[envName] : undefined;
  if (envVal) return envVal;
  const where = envName ? `环境变量 ${envName}` : '';
  throw new Error(`角色 ${role} 缺少 API key${where ? `（需在 ${where} 或 075.json roles.${role}.key 中配置）` : '（需在 075.json roles.' + role + '.key 中配置）'}`);
}

function loadRoleConfig(configPath, requiredRoles) {
  if (!fs.existsSync(configPath)) {
    throw new Error(`角色配置文件缺失: ${configPath}（按 openspec 要求必须提供 075.json 配置各角色 API）`);
  }
  const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const roles = cfg.roles ?? {};
  // 只校验本模式实际用到的角色（fail-fast 范围随 --role 收窄）
  for (const role of requiredRoles ?? ['tester', 'kimi', 'domain-invariant', 'repair', 'ds', 'mentor']) {
    if (!roles[role]) throw new Error(`075.json 缺少角色定义: ${role}`);
    if (!roles[role].model) throw new Error(`075.json 角色 ${role} 缺少 model`);
    if (!roles[role].provider) throw new Error(`075.json 角色 ${role} 缺少 provider`);
    keyFor(cfg, role); // fail-fast
  }
  return cfg;
}

/** 各单角色模式实际调用的角色（决定 key/端点校验范围）: prober 调 tester + kimi 双探针，
 *  patcher 调 domain-invariant(sci) + repair(general) + ds，mentor 只调 mentor。 */
function rolesForMode(mode) {
  switch (mode) {
    case 'prober': return ['tester', 'kimi'];
    case 'patcher': return ['domain-invariant', 'repair', 'ds'];
    case 'mentor': return ['mentor'];
    default: return ['tester', 'kimi', 'domain-invariant', 'repair', 'ds', 'mentor'];
  }
}

/** --only-roles 通道名 → 各侧内部角色：ds = deepseek 系（prober tester / patcher ds）。 */
const CHANNEL_ROLES = {
  ds: { prober: ['tester'], patcher: ['ds'] },
  kimi: { prober: ['kimi'], patcher: [] },
  sci: { prober: [], patcher: ['sci'] },
  general: { prober: [], patcher: ['general'] }
};
/** patcher 通道名 → 075.json 角色 key（ds 通道角色 key 即 'ds'）。 */
const PATCHER_ROLE_KEYS = { sci: 'domain-invariant', general: 'repair', ds: 'ds' };

/** mtime 最新的 run 目录（run_patcher / run_mentor 缺省 --run-dir 时自动选用）。 */
function latestRunDir(artifactsRoot) {
  if (!fs.existsSync(artifactsRoot)) return '';
  const dirs = fs
    .readdirSync(artifactsRoot)
    .map((d) => path.join(artifactsRoot, d))
    .filter((p) => fs.statSync(p).isDirectory())
    .map((p) => ({ p, m: fs.statSync(p).mtimeMs }));
  if (dirs.length === 0) return '';
  dirs.sort((a, b) => b.m - a.m);
  return dirs[0].p;
}

function buildOptions(workspaceRoot, maxRetries, cfg, mode, repairTimeoutMin, onlyRoles, probeTimeoutMin) {
  mode = mode || 'full';
  // expert* 表用途：probe 阶段按 expertRoles 加载专家报告；sci patcher 复用 domain-invariant 配置；
  // ds patcher 复用 deepseek（同 tester 提供商），patcher 模式下按 expert.* 字段解析
  // --only-roles 通道子集：只解析启用通道的 model/key/provider（未启用通道不做 key fail-fast）
  const proberRoles = onlyRoles?.prober ?? ['tester', 'kimi'];
  const patcherRoles = onlyRoles?.patcher ?? ['sci', 'general', 'ds'];
  const patcherKeyOf = (r) => (r === 'domain-invariant' ? 'sci' : r === 'ds' ? 'ds' : null);
  const expertRoles = ['tester', 'kimi'].filter((r) => proberRoles.includes(r));
  const expertModels = {};
  const expertKeys = {};
  const expertProviders = {};
  const proberFillBase = ['tester', 'kimi'].filter((r) => proberRoles.includes(r));
  const patcherFillBase = ['domain-invariant', 'ds'].filter((r) => {
    const ch = patcherKeyOf(r);
    return ch ? patcherRoles.includes(ch) : true;
  });
  const fillRoles =
    mode === 'patcher' ? patcherFillBase
    : mode === 'mentor' ? []
    : mode === 'prober' ? proberFillBase
    : proberFillBase.concat(patcherFillBase);
  for (const role of fillRoles) {
    expertModels[role] = cfg.roles[role].model;
    expertKeys[role] = keyFor(cfg, role);
    expertProviders[role] = providerFor(cfg, cfg.roles[role].provider);
  }
  const repairRole = cfg.roles['repair'];
  const mentorRole = cfg.roles['mentor'];
  const repairFields =
    (mode === 'patcher' || mode === 'full') && patcherRoles.includes('general')
      ? {
          repairModel: repairRole.model,
          repairKey: keyFor(cfg, 'repair'),
          repairProvider: providerFor(cfg, repairRole.provider)
        }
      : {};
  const mentorFields =
    mode === 'mentor' || mode === 'full'
      ? {
          mentorModel: mentorRole.model,
          mentorKey: keyFor(cfg, 'mentor'),
          mentorProvider: providerFor(cfg, mentorRole.provider)
        }
      : {};
  return {
    workspaceRoot,
    publicCommand: 'python3 reproduce.py',
    maxRetries,
    artifactsRoot: path.join(workspaceRoot, '.codex-sci-debug', 'runs'),
    codexPath: 'codex',
    model: '',
    sandbox: 'danger-full-access',
    cwd: workspaceRoot,
    // 单角色停止点传给 orchestrator（它读 options.onlyStage）: prober 停在 probe-done，
    // patcher 停在 patcher-done，mentor 跑到终审完为止
    onlyStage: mode === 'prober' ? 'probe' : mode === 'patcher' ? 'patcher' : mode === 'mentor' ? 'mentor' : undefined,
    // probe 阶段双 prober（tester/kimi 均 → ds flash：deepseek-chat + medium，providers.deepseek-flash）：限时 15 分钟并写入 prompt；失败不阻塞后续
    expertRoles,
    expertTimeoutMs: (Number.isFinite(probeTimeoutMin) && probeTimeoutMin > 0 ? probeTimeoutMin : 15) * 60 * 1000,
    // repair 三 patcher 并行出 patch（sci+general+ds）：限时 20 分钟强制交卷，随后直接进 mentor 环节
    // ★ --repair-timeout-min 0 = 不限时（无限时间，会话自然结束才交卷）；>0 = 分钟级限时；缺省 20 分钟
    repairTimeoutMs:
      repairTimeoutMin === 0
        ? 0
        : (Number.isFinite(repairTimeoutMin) && repairTimeoutMin > 0 ? repairTimeoutMin : 20) * 60 * 1000,
    // mentor 选择阶段：强制 15 分钟按 rubric 选优；选不出则 20 分钟按规则选定更优候选并修补打磨（无再生成轮、不从零自写）
    mentorTimeoutMs: 15 * 60 * 1000,
    mentorPolishTimeoutMs: 20 * 60 * 1000,
    expertModels,
    expertKeys,
    expertProviders,
    // 通道子集（--only-roles）：patcher 阶段只跑启用的通道，未启用通道以 skipped 占位记录
    onlyRepairRoles:
      mode === 'patcher' || mode === 'full'
        ? ['sci', 'general', 'ds'].filter((s) => patcherRoles.includes(s))
        : undefined,
    ...repairFields,
    ...mentorFields,
    expertKnowledge: {},
    knowledgeDir: '',
    // mentor 单角色模式：禁用打回再生成（只在已有候选上打分/修补打磨）
    mentorMaxRegenerations: mode === 'mentor' ? 0 : cfg.mentorMaxRegenRounds ?? 0
  };
}

function buildIntake(workspaceRoot) {
  const problemDesc = fs.readFileSync(path.join(workspaceRoot, 'problem_desc.txt'), 'utf8').trim();
  return (
    '用户（非专业程序员）报告的问题：\n' +
    problemDesc +
    '\n\n（工作区即 task 目录：C++ 源码在 source/，论文/材料在 paper.md、MATERIALS.json，' +
    'public 诊断命令 `python3 reproduce.py` 在 task 根目录，可直接运行验证。）'
  );
}

async function main() {
  let workspace = argOf('--workspace', '');
  if (!workspace || !fs.existsSync(workspace)) {
    const candidate = fs
      .readdirSync('/tmp')
      .filter((d) => d.startsWith('swe-075-workspace-'))
      .map((d) => `/tmp/${d}`)
      .sort()
      .pop();
    if (!candidate) {
      console.error('用法: node tools/swe-bench-science/run-dual-075.js [--workspace <dir>]');
      console.error('（或先产出 /tmp/swe-075-workspace-* 工作目录）');
      process.exit(1);
    }
    process.stderr.write(`[run-dual-075] 使用最新工作区 ${candidate}\n`);
    workspace = candidate;
  }
  // codex exec 以 spawn 的 cwd 为基准解析 -C 参数：相对 workspace 会让 -C 被二次拼接，
  // 直接以 "No such file or directory (os error 2)" 死掉。统一绝对化，保证 cwd/-C 一致。
  workspace = path.resolve(workspace);
  const role = argOf('--role', 'full');
  if (!['full', 'prober', 'patcher', 'mentor'].includes(role)) {
    console.error(`[run-dual-075] 未知 --role: ${role}（可用: full | prober | patcher | mentor）`);
    process.exit(2);
  }
  // mentor 单角色模式不允许打回再生成 → 强制 0 轮重试
  const maxRetries = parseInt(argOf('--max-retries', role === 'mentor' ? '0' : '1'), 10);
  const fromRunDir = argOf('--from-run', '');
  if (fromRunDir && !fs.existsSync(fromRunDir)) {
    console.error(`[run-dual-075] --from-run 目录不存在: ${fromRunDir}`);
    console.error('（断点续跑需要传入含 probe-report-*.json 与 patch-r1-*.diff 的历史 run 产物目录）');
    process.exit(2);
  }
  // 默认相对仓库根解析（runner 位于 tools/swe-bench-science/，与 cwd 无关）
  const defaultConfig = path.resolve(__dirname, '..', '..', 'swe-bench-sci', '075.json');
  const configPath = argOf('--config', defaultConfig);
  const onlyRolesRaw = argOf('--only-roles', '');
  let enabledProberRoles, enabledPatcherRoles;
  if (onlyRolesRaw.trim()) {
    const names = onlyRolesRaw.split(',').map((x) => x.trim()).filter(Boolean);
    for (const n of names) {
      if (!CHANNEL_ROLES[n]) {
        console.error(`[run-dual-075] 未知 --only-roles 通道: ${n}（可用: ds, kimi, sci, general）`);
        process.exit(2);
      }
    }
    enabledProberRoles = [...new Set(names.flatMap((n) => CHANNEL_ROLES[n].prober))];
    enabledPatcherRoles = [...new Set(names.flatMap((n) => CHANNEL_ROLES[n].patcher))];
    if (role === 'prober' && enabledProberRoles.length === 0) {
      console.error(`[run-dual-075] --only-roles ${names.join(',')} 未启用任何 prober 通道（prober 侧可用: ds, kimi）`);
      process.exit(2);
    }
    if ((role === 'patcher' || role === 'full') && enabledPatcherRoles.length === 0) {
      console.error(`[run-dual-075] --only-roles ${names.join(',')} 未启用任何 patcher 通道（patcher 侧可用: sci, general, ds）`);
      process.exit(2);
    }
    console.log(`[run-dual-075] 通道子集: prober [${enabledProberRoles.join(', ')}] / patcher [${enabledPatcherRoles.join(', ')}]`);
  } else {
    enabledProberRoles = ['tester', 'kimi'];
    enabledPatcherRoles = ['sci', 'general', 'ds'];
  }
  const patcherKeyOfRole = (r) => Object.entries(PATCHER_ROLE_KEYS).find(([, v]) => v === r)?.[0];
  const requiredRoles = rolesForMode(role).filter((r) => {
    if (r === 'tester' || r === 'kimi') return enabledProberRoles.includes(r);
    if (['domain-invariant', 'repair', 'ds'].includes(r)) {
      const ch = patcherKeyOfRole(r);
      return ch ? enabledPatcherRoles.includes(ch) : true;
    }
    return true; // mentor 等其余角色不受 --only-roles 收窄
  });
  let cfg;
  try {
    cfg = loadRoleConfig(configPath, requiredRoles);
  } catch (err) {
    console.error(`[run-dual-075] 角色配置校验失败: ${err.message}`);
    console.error('[run-dual-075] 请补齐 075.json（或对应环境变量）后重启；详见项目根 README-swe-bench-sci.md');
    process.exit(2);
  }
  console.log(`[run-dual-075] 角色配置: ${configPath}（模式 ${role}，校验角色: ${requiredRoles.join(', ')}）`);
  for (const r of requiredRoles) {
    console.log(`  ${r}: ${cfg.roles[r].model} @ ${cfg.roles[r].provider}`);
  }
  // --repair-timeout-min: 分钟数；0/unlimited/off 表示不限时（无限时间）
  const repairTimeoutRaw = String(argOf('--repair-timeout-min', '20')).trim();
  const repairUnlimited = /^(0|unlimited|inf|infinite|off|none)$/i.test(repairTimeoutRaw);
  const repairTimeoutMin = repairUnlimited ? 0 : parseInt(repairTimeoutRaw, 10);
  const probeTimeoutMin = parseInt(argOf('--probe-timeout-min', '15'), 10);
  const opts = buildOptions(workspace, maxRetries, cfg, role, repairTimeoutMin, {
    prober: enabledProberRoles,
    patcher: enabledPatcherRoles
  }, probeTimeoutMin);
  if (repairTimeoutMin !== 20) {
    console.log(
      repairTimeoutMin === 0
        ? '[run-dual-075] repair 时限: ★ 不限时（无限时间，会话跑到自然结束才交卷）★'
        : `[run-dual-075] repair 时限: ${repairTimeoutMin} 分钟（--repair-timeout-min）`
    );
  }
  if (probeTimeoutMin !== 15) {
    console.log(`[run-dual-075] probe 专家时限: ${probeTimeoutMin} 分钟（--probe-timeout-min）`);
  }
  const probeResumeDir = argOf('--probe-resume', '');
  if (probeResumeDir) {
    const resumeMap = {};
    for (const f of fs.readdirSync(path.join(probeResumeDir, 'raw')).filter((n) => n.endsWith('.stream.jsonl'))) {
      const role = f.replace(/\.stream\.jsonl$/, '');
      const lines = fs.readFileSync(path.join(probeResumeDir, 'raw', f), 'utf8').split('\n');
      const sessionId = lines.map((l) => { try { return JSON.parse(l).session_id; } catch { return undefined; } }).find(Boolean);
      if (sessionId) resumeMap[role] = sessionId;
    }
    if (Object.keys(resumeMap).length > 0) {
      opts.expertResumeThreadIds = resumeMap;
      console.log(`[run-dual-075] 断点续跑: 恢复会话 ${JSON.stringify(resumeMap)}（来源 ${probeResumeDir}/raw）`);
    } else {
      console.error(`[run-dual-075] --probe-resume 目录 ${probeResumeDir}/raw 下未找到 session_id，按全新会话运行`);
    }
  }
  if (fromRunDir) opts.resumeFromPreviousRunDir = path.resolve(fromRunDir);

  if (fromRunDir) {
    console.log(`[run-dual-075] 断点续跑模式：复用 ${fromRunDir}，跳过 probe/repair，直接进 mentor 终审`);
  }

  // 单角色模式：patcher / mentor 必须挂在同一个 run 目录上（prober 产出的目录）
  if (role === 'patcher' || role === 'mentor') {
    const artifactsRoot = path.join(workspace, '.codex-sci-debug', 'runs');
    let runDir = argOf('--run-dir', '');
    if (!runDir) runDir = latestRunDir(artifactsRoot);
    if (!runDir || !fs.existsSync(runDir)) {
      console.error(`[run-dual-075] ${role} 模式需要 run 目录，但未找到（${runDir || artifactsRoot} 不存在）。请先运行 prober。`);
      process.exit(2);
    }
    runDir = path.resolve(runDir);
    if (role === 'patcher') {
      const hasProbes =
        fs.existsSync(path.join(runDir, 'probes', 'manifest.json')) ||
        fs.existsSync(path.join(runDir, 'probe-report-tester.json')) ||
        fs.existsSync(path.join(runDir, 'probe-report-kimi.json'));
      if (!hasProbes) {
        // ★ 去预言机化（2026-09-16）：缺少 prober 产物**不是**阻塞条件——探针只是参考证据，
        //   不是门禁。patcher 在「无参考证据」的条件下照常运行（prompt 会显示（无探针））。★
        console.warn(`[run-dual-075] 提示：run 目录 ${runDir} 没有 prober 产物（probes/manifest.json / probe-report-*.json）；` +
          `探针不是门禁，patcher 将在无参考证据的条件下继续运行。`);
      }
    }
    if (role === 'mentor') {
      const hasDiff =
        fs.existsSync(path.join(runDir, 'patch-r1-sci.diff')) ||
        fs.existsSync(path.join(runDir, 'patch-r1-general.diff')) ||
        fs.existsSync(path.join(runDir, 'patch-r1-ds.diff'));
      if (!hasDiff) {
        console.error(`[run-dual-075] run 目录 ${runDir} 缺少 patcher 候选 diff（patch-r1-*.diff）。请先运行 patcher。`);
        process.exit(2);
      }
    }
    opts.reuseRunDir = runDir;
    console.log(`[run-dual-075] ${role} 模式：复用 run 目录 ${runDir}`);
  }

  const ts = () => new Date().toISOString().slice(11, 19);
  const state = await runPipeline(buildIntake(workspace), opts, (event) => {
    if (event.type === 'stage') console.log(`[${ts()}] === 阶段: ${event.stage}${event.detail ? `（${event.detail}）` : ''} ===`);
    else if (event.type === 'expert') console.log(`[${ts()}] 专家 ${event.role}: ${event.status}`);
    else if (event.type === 'report') console.log(`[${ts()}] [${event.report.role}] 提问 ${event.report.questions.length}，暴露入口 ${event.report.exposure_paths.length}，探针 ${event.report.probes.length}`);
    else if (event.type === 'retry') console.log(`[${ts()}] ⚠ 第 ${event.round} 次打回：${event.reason}`);
    else if (event.type === 'patch') console.log(`[${ts()}] 📄 补丁（第 ${event.round} 轮，${event.source}）: ${event.path}`);
    else if (event.type === 'mentor') console.log(`[${ts()}] ⚖️ SciReviewer r${event.round}（${event.verdict}）：${event.summary}`);
    else if (event.type === 'activity') console.log(`[${ts()}] 📋 ${event.text}`);
    else if (event.type === 'finished') console.log(`[${ts()}] ${event.ok ? '✅ 完成' : '❌ 失败'}：${event.summary}`);
  });
  console.log(`[${ts()}] 最终状态: ${state.stage}${state.verifySummary ? `；${state.verifySummary}` : ''}`);
  process.exit(['done', 'probe-done', 'patcher-done'].includes(state.stage) ? 0 : 1);
}

main().catch((err) => {
  console.error('流水线异常:', err);
  process.exit(1);
});
