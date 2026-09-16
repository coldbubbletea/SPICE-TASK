import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile, execFileSync } from 'child_process';
import { CodexRunOptions, ModelProviderConfig, runCodexOnce } from '../agents/runner';
import { runExperts } from '../agents/experts';
import {
  CallChain,
  CONTRACT_QUOTAS,
  HiddenContract,
  Probe,
  ProbeBaselineGate,
  ProbeReport,
  RunState,
  VerifyResult,
  contractCoverage,
  writeArtifact
} from '../agents/schemas';
import {
  aggregateProbeBaselineGates,
  loadProbesFromRunDir,
  materializeProbes,
  runProbeBaselineGate,
  verify
} from './verifier';
import {
  ACCEPTANCE_SCOPE_CLAUSE,
  CONTRACT_COMPLETENESS_CLAUSE,
  KILL_LINE_CLAUSE,
  PROBER_GUIDANCE_STATUS_CLAUSE
} from './promptClauses';
import {
  MentorAgentOutcome,
  MentorComparison,
  MentorPolishSelection,
  MentorVerdict,
  mentorWeightedScore,
  parseMentorProgressLines,
  renderMentorEvaluationMarkdown,
  resolveMentorSelection,
  resolvePolishSelectionFromProgress,
  resolvePolishTargetByVerify,
  runMentor,
  runMentorPolish
} from './mentor';

export interface PipelineOptions extends CodexRunOptions {
  workspaceRoot: string;
  publicCommand: string;
  maxRetries: number;
  artifactsRoot: string;
  repairTimeoutMs?: number;
  /** ★ 通道子集（ds-only 等政策）：仅启用列表内的 patcher 通道；未启用通道不走会话，以 skipped 占位结果记录 ★ */
  onlyRepairRoles?: Array<'sci' | 'general' | 'ds'>;
  expertTimeoutMs?: number;
  pythonPath?: string;
  /**
   * ★ 本底诊断开关（默认开）★：prober 交卷后，把探针在**未修复的工作区**上真跑一遍，
   * 得到「哪些探针在本底就有判别力」的诊断证据，并回灌 prober 反射轮作为参考。
   * ★ 探针不是验收门禁 ★：诊断结果一律不剔除探针、不阻断流程、不影响 run 成败——
   * 验收只由 public 测试决定。置 false 可关闭（仅调试用）。
   */
  probeBaselineGate?: boolean;
  expertModels?: Record<string, string>;
  repairModel?: string;
  expertKeys?: Record<string, string>;
  repairKey?: string;
  expertProviders?: Record<string, ModelProviderConfig>;
  repairProvider?: ModelProviderConfig;
  expertKnowledge?: Record<string, string>;
  knowledgeDir?: string;
  mentorModel?: string;
  /** 只运行这些角色的专家（默认全部：tester + kimi，双 prober 并行）。 */
  expertRoles?: string[];
  mentorKey?: string;
  mentorProvider?: ModelProviderConfig;
  mentorTimeoutMs?: number;
  /** SciReviewer "修补打磨"会话超时（规则选定更优候选之后；建议 20 分钟；缺省回落 mentorTimeoutMs）。 */
  mentorPolishTimeoutMs?: number;
  /** SciReviewer 打回 patcher 再生成的最大次数（默认 1；用尽后按规则选定更优候选并在其基础 diff 上修补打磨）。 */
  mentorMaxRegenerations?: number;
  /**
   * 断点续跑：从指定上一 run 目录复用探针报告与三候选 diff，
   * 跳过 probe/repair，直接进入 mentor 终审（非阻塞规则下仍照常喂入全部候选）。
   */
  resumeFromPreviousRunDir?: string;
  /**
   * 续跑指定 patcher 通道的上一次会话（source → session_id）：让该通道的 repair 会话从上一轮上下文继续，
   * 而不是从零重跑（省 token、避免重复探索）。未列出的通道照常按全新会话运行。
   */
  expertResumeThreadIds?: Record<string, string>;
  /** 单角色拆分模式：只执行指定阶段并停下（run_prober / run_patcher / run_mentor 分别调用）。 */
  onlyStage?: 'probe' | 'patcher' | 'mentor';
  /** 复用已存在的 run 目录（单角色模式下 patcher/mentor 与 prober 共享同一 run 目录）。 */
  reuseRunDir?: string;
}

export type PipelineEvent =
  | { type: 'stage'; stage: RunState['stage']; detail?: string }
  | { type: 'expert'; role: string; status: 'started' | 'done' | 'failed' | 'recovered-from-jsonl' }
  | { type: 'report'; report: ProbeReport }
  | { type: 'activity'; text: string }
  | { type: 'retry'; round: number; reason: string }
  | { type: 'patch'; round: number; source: 'sci' | 'general' | 'ds' | 'mentor'; path: string }
  | { type: 'mentor'; round: number; verdict: 'accept' | 'regenerate' | 'error'; summary: string; choice?: string }
  | { type: 'finished'; ok: boolean; summary: string };

const ACTIVITY_FLUSH_MS = 3 * 60 * 1000;

/** 角色文件夹自名映射（命名约定：agent 必须先在 <kind>/<selfName>/<selfName>.md 写自名声明，再写产物）。
 *  prober: tester→ds、kimi→kimi；patcher: sci→qwen、general→glm、ds→ds。 */
const PROBER_AGENT_NAMES: Record<string, string> = { tester: 'ds', kimi: 'kimi' };
const PATCHER_AGENT_NAMES: Record<string, string> = { sci: 'qwen', general: 'glm', ds: 'ds' };

/** 写入 agent 自名声明文件 <runDir>/<kind>/<selfName>/<selfName>.md（角色/模型/提供商/时间戳/计划产物清单）。 */
function writeAgentSelfDecl(runDir: string, kind: 'prober' | 'patcher', selfName: string, fields: Record<string, string>): void {
  const lines = [
    `# ${kind}/${selfName} — 自名声明`,
    '',
    ...Object.entries(fields).map(([k, v]) => `- ${k}: ${v}`),
    `- timestamp: ${new Date().toISOString()}`,
    `- planned artifacts: 本目录后续写入的 ${kind === 'prober' ? 'probe-report 与物化探针' : 'patch / verify 结果'}`
  ];
  writeArtifact(runDir, `${kind}/${selfName}/${selfName}.md`, lines.join('\n'));
}

/** 活动日志节流器：动作实时收集，每 3 分钟汇总一行落盘并上屏。 */
function makeActivityLogger(runDir: string, emit: (event: PipelineEvent) => void) {
  const logFile = path.join(runDir, 'activity.log');
  let pending: string[] = [];
  let total = 0;
  const flush = (final = false) => {
    if (pending.length === 0 && !final) {
      return;
    }
    const stamp = new Date().toISOString().slice(11, 19);
    const last = pending[pending.length - 1];
    const line = pending.length === 0
      ? `[${stamp}] （本时段无新动作，累计 ${total} 个）`
      : `[${stamp}] 本时段 ${pending.length} 个动作（累计 ${total}），最近: ${(last ?? '').slice(0, 200)}`;
    fs.appendFileSync(logFile, line + '\n');
    if (pending.length > 0) {
      emit({ type: 'activity', text: line });
    }
    pending = [];
  };
  const timer = setInterval(() => flush(), ACTIVITY_FLUSH_MS);
  return {
    record(activity: string) {
      total++;
      pending.push(activity);
      fs.appendFileSync(logFile, activity + '\n');
    },
    stop() {
      clearInterval(timer);
      flush(true);
    }
  };
}

function mergeReports(reports: ProbeReport[]): {
  paths: string;
  probes: Probe[];
  contracts: HiddenContract[];
  chains: CallChain[];
} {
  const allPaths: string[] = [];
  const allProbes: Probe[] = [];
  const allContracts: HiddenContract[] = [];
  const allChains: CallChain[] = [];
  const seenProbeIds = new Set<string>();
  const seenContractIds = new Set<string>();
  const seenChainEntries = new Set<string>();
  for (const report of reports) {
    for (const p of report.exposure_paths ?? []) {
      allPaths.push(`- [${report.role}] ${p.file} :: ${p.symbol} — ${p.how}`);
    }
    // ★ 第一交付物：隐藏契约（按 id 去重，保留首个提出者；locus+statement 相同视为同一条）★
    for (const c of report.hidden_contracts ?? []) {
      const key = `${c.id}|${c.locus}|${c.statement}`;
      if (seenContractIds.has(key)) continue;
      seenContractIds.add(key);
      allContracts.push(c);
    }
    // ★ 结构图：入口 → 调用链（按 entry+chain 去重）★
    for (const ch of report.structure_map ?? []) {
      const key = `${ch.entry}|${ch.chain}`;
      if (seenChainEntries.has(key)) continue;
      seenChainEntries.add(key);
      allChains.push(ch);
    }
    for (const probe of report.probes ?? []) {
      if (!seenProbeIds.has(probe.id)) {
        seenProbeIds.add(probe.id);
        allProbes.push(probe);
      }
    }
  }
  return { paths: allPaths.join('\n'), probes: allProbes, contracts: allContracts, chains: allChains };
}

/**
 * 物化「隐藏契约 + 仓库结构图」到工作副本（verify/contracts.md + verify/contracts.json）。
 * ★ 只是 prober 的一家之言（线索），不是验收门禁：patcher 必须逐条独立核实。★
 */
function materializeContracts(
  dir: string,
  contracts: HiddenContract[],
  chains: CallChain[],
  relDir: string = 'verify'
): string | undefined {
  if (contracts.length === 0 && chains.length === 0) return undefined;
  const outDir = path.join(dir, relDir);
  fs.mkdirSync(outDir, { recursive: true });
  const lines: string[] = [
    '# prober 识别的隐藏契约 + 仓库结构图（★ 可错的一家之言，请逐条独立核实 ★）',
    '',
    '> 这不是验收标准、不是规范、也不保证正确（可能漏、可能错、可能过度一般化）。',
    '> 用法：把每条契约当作「待验证的假设」——回读 evidence 里的 file:line，自己判断它是否真的成立。',
    '> 你不得因为这里写了什么就改代码，也不得因为这里没写就漏修 public 契约要求的行为。',
    ''
  ];
  if (contracts.length > 0) {
    lines.push('## 隐藏契约', '');
    for (const c of contracts) {
      lines.push(`### [${c.id}] (${c.kind}) ${c.statement}`, '');
      lines.push(`- 站点 locus: \`${c.locus}\`${c.enforced_by ? `  | 谁在守护: ${c.enforced_by}` : ''}`);
      lines.push(`- 发现方式: ${c.discovered_via}`);
      lines.push(`- 证据: ${c.evidence}`);
      if (c.confidence !== undefined && c.confidence !== '') lines.push(`- prober 自评置信度: ${c.confidence}`);
      if (c.scope) lines.push(`- 适用范围: ${c.scope}`);
      lines.push(`- 违反即（反例风险）: ${c.violates_if}`);
      lines.push(`- 要求你要做的: ${c.patcher_action}`);
      if (c.probe_ids?.length) lines.push(`- 相关探针（可选证据）: ${c.probe_ids.join(', ')}`);
      if (c.open_question && c.open_question.trim() && c.open_question.trim() !== '无') {
        lines.push(`- ⚠ 未决问题（prober 也没确定，需由你判断）: ${c.open_question}`);
      }
      lines.push('');
    }
  }
  if (chains.length > 0) {
    lines.push('## 仓库结构图（入口 → 调用链 → 契约站点 / 兄弟调用点）', '');
    for (const ch of chains) {
      lines.push(`- 入口 \`${ch.entry}\``);
      lines.push(`  - 链路: ${ch.chain}`);
      lines.push(`  - 终点说明: ${ch.termination}`);
      if (ch.siblings?.length) lines.push(`  - 兄弟调用点（共享同一契约，改一处要一并评估）: ${ch.siblings.join(' | ')}`);
      if (ch.note) lines.push(`  - 备注: ${ch.note}`);
    }
    lines.push('');
  }
  fs.writeFileSync(path.join(outDir, 'contracts.md'), lines.join('\n'));
  fs.writeFileSync(
    path.join(outDir, 'contracts.json'),
    JSON.stringify({ source: 'probe-stage', hidden_contracts: contracts, structure_map: chains }, null, 2)
  );
  return path.join(outDir, 'contracts.md');
}

function buildRepairPrompt(
  intake: string,
  reports: ProbeReport[],
  retryFeedback: string | undefined,
  framing: string,
  timeLimitMs?: number,
  baseline?: ProbeBaselineGate
): string {
  const all = mergeReports(reports);
  // ★ 探针一律保留、一律物化：本底诊断只标注「信息量低」，既不剔除也不作为门禁 ★
  const merged = { paths: all.paths, probes: all.probes, contracts: all.contracts, chains: all.chains };
  // ★ 第一交付物区块：隐藏契约（按 kind 分组，供 patcher 逐条独立核实）★
  const contractBlock = merged.contracts.length
    ? `=== ★ prober 识别的隐藏契约（★ 第一交付物：prober 的一家之言，需你逐条独立核实 ★）★ ===
（同一份清单也物化在你的工作目录 \`verify/contracts.md\` + \`verify/contracts.json\`，可随时回读。）
（阅读方式：每条的 locus 是「契约在哪生效」，violates_if 是「什么样的修复会破坏它」——这是给你最省时间的反例清单；
evidence 是 prober 的出处，必须自己回读 file:line 复核；confidence 低或 open_question 非「无」= prober 自己也没把握，尤其要独立判断。）
${merged.contracts
        .map((c) => {
          const conf =
            c.confidence === undefined || c.confidence === '' ? '' : `（prober 自评置信度 ${c.confidence}）`;
          const lines = [
            `- [${c.id}] (${c.kind}) ${c.statement}`,
            `  站点 locus: ${c.locus}${c.enforced_by ? `  | 谁在守护: ${c.enforced_by}` : ''}`,
            `  发现方式: ${c.discovered_via}`,
            `  证据: ${c.evidence}${conf}`,
            `  违反即: ${c.violates_if}`,
            `  你的动作: ${c.patcher_action}`
          ];
          if (c.scope) lines.push(`  适用范围: ${c.scope}`);
          if (c.open_question && c.open_question.trim() && c.open_question.trim() !== '无') {
            lines.push(`  ⚠ 未决问题（prober 也没确定，需由你判断）: ${c.open_question}`);
          }
          if (c.probe_ids?.length) lines.push(`  相关探针: ${c.probe_ids.join(', ')}（可选证据，见下文探针段）`);
          return lines.join('\n');
        })
        .join('\n')}
（★ 这些契约不是验收门禁，也不保证正确：可能漏、可能错、可能过度一般化。你的修复必须自己论证正确性，不得因为「契约 3 这么写」就改代码或回避正确修法。★）
`
    : '';

  const structureBlock = merged.chains.length
    ? `=== ★ 仓库结构图（入口 → 调用链 → 契约站点 / 兄弟调用点）★ ===
（用途：判断「同一个契约还有哪些兄弟调用点被同一处改动影响」——漏改兄弟调用点是最常见的失败模式。）
${merged.chains
        .map((ch) => {
          const lines = [`- 入口 ${ch.entry}`, `  链路: ${ch.chain}`, `  终点说明: ${ch.termination}`];
          if (ch.siblings?.length) lines.push(`  兄弟调用点（共享同一契约，改一处要一并评估）: ${ch.siblings.join(' | ')}`);
          if (ch.note) lines.push(`  备注: ${ch.note}`);
          return lines.join('\n');
        })
        .join('\n')}
`
    : '';

  const lowSignal = new Set(baseline?.low_signal_probes ?? []);
  const lowSignalLines = (baseline?.results ?? [])
    .filter((r) => lowSignal.has(r.probe_id))
    .map((r) => {
      const why =
        r.classification === 'non_discriminating'
          ? '在未修复本底上就通过（修复前后行为相同，对本次修复判别力低）'
          : '探针自身在本底上跑不起来（语法/导入/路径问题，可能是坏探针）';
      return `- ${r.probe_id} ★ ${why}`;
    });
  const probeList = merged.probes
    .map((p) => {
      const conf =
        p.confidence === undefined || p.confidence === ''
          ? ''
          : `（prober 自评置信度 ${p.confidence}）`;
      const parts = [`- ${p.id} (${p.kind}) ${p.title}: 预期 ${p.expect}${conf}`];
      if (p.patcher_guidance) {
        parts.push(`  出题人指引（prober 的一家之言，需你独立核实后才算依据）: ${p.patcher_guidance}`);
      }
      if (p.open_question && p.open_question.trim() && p.open_question.trim() !== '无') {
        parts.push(`  ⚠ 未决问题（prober 自己也没确定，需由你判断）: ${p.open_question}`);
      }
      return parts.join('\n');
    })
    .join('\n');
  const probeRunList = merged.probes
    .map((p) => `- ${p.id}: 运行 ${p.kind === 'shell' ? 'sh verify/probes/' + p.id + '.sh' : 'python3 verify/probes/' + p.id + '.py'}`)
    .join('\n');
  // ★ 假设决策层（probe_skill §8）：kill line 只是**导航线索**（不是判决）——先在未修改代码上复现本底结论，
  //   改完后同一条命令最好翻转；不翻转不等于修复失败（prober 的假设本身可能是错的）。
  //   ★ 所有探针一律只是参考证据，没有任何一条能决定验收 ★
  const rankNum = (r: unknown): number => {
    if (typeof r === 'number' && Number.isFinite(r)) return r;
    if (typeof r === 'string') {
      const m = r.match(/\d+/);
      if (m) return Number(m[0]);
    }
    return Number.MAX_SAFE_INTEGER;
  };
  const killLineProbes = merged.probes
    .filter((p) => typeof p.kill_line === 'string' && p.kill_line.trim())
    .sort((a, b) => rankNum(a.rank) - rankNum(b.rank));
  const killLineBlock = killLineProbes.length
    ? `=== ★ 导航线索：假设 kill line（建议逐个亲自运行；先用未修改代码确认本底结论，改完再跑同一条看是否翻转）★ ===\n${killLineProbes
        .map((p) => {
          const rank = p.rank !== undefined && p.rank !== '' ? `[rank ${p.rank}] ` : '';
          const alt =
            typeof p.alt_sites === 'string' && p.alt_sites.trim()
              ? `\n  备选站点（prober 建议也先用本底实测确认；不要盲目改动）: ${p.alt_sites}`
              : '';
          return `- ${rank}${p.id} ${p.title}\n  命令: ${p.kill_line}\n  反证判据 refutes_if + 本底实测: ${p.falsifier ?? '（prober 未记录本底实测，请先自行跑一次并记录）'}${alt}`;
        })
        .join('\n')}\n`
    : '';
  // ★ 时间预算块：timeLimitMs > 0 = 限时交卷；timeLimitMs === 0 = 显式不限时（无限时间）；undefined = 不注入。
  const timeBlock =
    typeof timeLimitMs === 'number' && timeLimitMs <= 0
      ? '\n=== 时间预算（★ 不限时：会一直等你交卷为止 ★）===\n- 本任务不设硬性时限，会话不会被强制掐断；可以在充分验证后再交卷。\n- 但时间充裕不等于可以先长时间只读探索：必须尽早把修改直接写进工作区文件（不要只在回复里给建议），随后按第 4 条自验证循环逐条复测；确认修好后主动结束会话交卷（系统会捕获 git diff）。\n'
      : timeLimitMs
        ? `\n=== 时间限制（硬约束）===\n- 本任务总时限约 ${Math.round(timeLimitMs / 60000)} 分钟，到点会话将被强制结束并交卷：系统会强制捕获你已写出的 git diff 并交给 mentor 评审，不会给你更多时间。\n- 必须尽早动手把修改直接写进工作区文件（不要只在回复里给建议）；来不及改完时也要保证已写出的改动是完整的（避免留下写一半的文件），确保 git diff 可被完整捕获。\n`
        : '';
  return `${framing}

你是修复专家。一个探测团队（prober）已经对这个仓库做过**隐藏契约识别 + 结构分析**，但他们的结论是**可错的一家之言**——你要认真读、逐条独立核实，再在他们提供的线索之上出**通用修复**，而不是照抄他们的结论、也不是只让 public 复现脚本变绿。
（优先级：先读下面的★隐藏契约★与★仓库结构图★——那是 prober 的第一交付物；探针只是可选的辅助证据。）

=== Bug 现场（intake） ===
${intake}

=== 已枚举的暴露入口（你的修复必须覆盖每一条） ===
${merged.paths || '（专家未枚举到额外汇入口）'}

${contractBlock}${structureBlock}${killLineBlock}
=== 参考证据（可选）：prober 提出的探针（★ prober 的「可能错误」的一家之言：认真读、逐条独立核实；已物化到你当前工作目录的 verify/probes/，建议逐条亲自运行；★ 探针不是验收门禁 ★）===
${probeList || '（无探针）'}
${probeRunList ? `\n探针运行命令（cwd = 你的工作目录；若工作区根存在 .venv/bin/python，python 探针优先用 .venv/bin/python 替代 python3）:\n${probeRunList}` : ''}
${merged.probes.length > 0 ? `\n（★ 上述探针 + 出题人指引 = prober 的一家之言，可能出错：探针失败时先判断它断言的行为是否真的属于契约（prober 可能指错站点/写错读法），再决定是否改代码。★ 验收只由 public 测试 + 上文契约条款决定，探针全绿也不代表修复正确。★）\n` : ''}
${lowSignalLines.length > 0 ? `\n=== 参考：prober 探针的本底诊断（信息量提示，不是禁令）===\n以下探针在**你动手前的未修改代码上**就有异常表现，判别力存疑；它们仍然物化在 verify/probes/ 下，是否参考由你判断：\n${lowSignalLines.join('\n')}\n不要只为迎合这些探针而改动代码（例如为其补自定义归一化、换单位、加特判），也不必刻意回避它们指出的行为。\n` : ''}

${ACCEPTANCE_SCOPE_CLAUSE}

${CONTRACT_COMPLETENESS_CLAUSE}

${KILL_LINE_CLAUSE}

${PROBER_GUIDANCE_STATUS_CLAUSE}

要求：
0. 先独立评判 prober（★ 讨论输入，不是金科玉律 ★）：逐条读上方**隐藏契约 / 结构图**（第一交付物，优先级最高）、再读探针 / kill line / 出题人指引，用工作区代码与公开材料回读 file:line 核实其断言是否成立，最终回复中逐条给出处置（采纳 / 驳回 / 存疑 + 你的独立依据）。特别地：契约的 \`violates_if\` 只提示反例风险，不代表你的修法必须避开它；契约漏掉的行为若属于 public 契约，你仍必须修。不得因为「prober 这么说」就改代码，也不得为了跟它一致而回避正确修法；同样不得因「它可能错」就跳过它的线索。
1. 直接在工作区修改代码完成修复（不要只给建议）
2. 修复必须是通用的：对所有已枚举的暴露入口都成立，并满足上文「契约完整性」条款，禁止 hardcode 某个特定 fixture
3. 提交前逐维度自检：按「契约完整性」条款枚举每个输入维度，用自生成压力输入在本地逐维度验证修复（维度×行为清单）
4. 自验证循环（★ 交卷前必须完成 ★）：
   a) 先跑上方 rank 1 的 kill line：在**未修改**代码上确认 prober 记录的本底结论，改完代码后看同一条命令是否给出 refutes_if（反证）结果；★ 不翻转不等于修复失败 ★（prober 可能指错站点、写错判据），但你要给出自己的独立解释 + 实测证据
   b) 按上文「探针运行命令」逐条运行 verify/probes/ 下每个探针（cwd = 你的工作目录）；探针失败时先判断该探针断言的行为是否真的属于契约（探针只是证据/回归网，不是验收标准，也不是规范），再决定是否改代码；若判定是探针本身错，写明错在哪并继续
   c) 同时运行 public 复现脚本（cwd = 工作目录根：\`python3 reproduce.py\`，若存在 .venv/bin/python 则优先用它）确认 public bug 已修复
   d) 每次修改后重跑 kill line + 全部探针 + public 复现脚本；最终回复中逐条附上 kill line、每个探针与 public 复现脚本的最终结果（PASS/FAIL + 关键输出）
5. 最终回复中逐条说明：每条暴露入口是如何被修复覆盖的、prober 每条指引与探针的处置结论（采纳/驳回/存疑）及依据，并附上第 3 条自检清单
${timeBlock}
${retryFeedback ? `\n=== 上一轮修复被打回的原因 ===\n${retryFeedback}\n请针对这些失败重新修复。\n` : ''}
`;
}

function buildDualRetryFeedback(semanticIssues: string[], guidance: string, comparison: MentorComparison): string {
  const lines: string[] = ['上一轮三位 patcher 的补丁均未通过 SciReviewer 终审。'];
  for (const issue of semanticIssues) {
    lines.push(`- 语义问题: ${issue}`);
  }
  if (guidance.trim()) {
    lines.push(`- SciReviewer 修复指导: ${guidance}`);
  }
  lines.push(`- SciPatcher-sci 上一轮结果: ${comparison.sci.verify.summary}`);
  lines.push(`- SciPatcher-general 上一轮结果: ${comparison.general.verify.summary}`);
  lines.push(`- SciPatcher-ds 上一轮结果: ${comparison.ds.verify.summary}`);
  return lines.join('\n');
}

/** Patcher 单角色断点重跑：复用 run 目录且已存在上一轮候选 diff/verify 结果时，
 *  自动汇编「上一轮各通道 diff + 探针逐条结果 + 摘要」作为 retryFeedback，
 *  让新一轮 patcher 在上一轮的基础上继续修，而不是从零开始。 */
function buildPrevRoundPatcherFeedback(runDir: string): string | undefined {
  let latestRound = 0;
  for (const name of fs.readdirSync(runDir)) {
    const m = name.match(/^comparison-r(\d+)\.json$/);
    if (m && Number(m[1]) > latestRound) {
      latestRound = Number(m[1]);
    }
  }
  if (latestRound === 0) {
    return undefined;
  }
  const round = latestRound;
  const comparison = JSON.parse(
    fs.readFileSync(path.join(runDir, `comparison-r${round}.json`), 'utf8')
  ) as MentorComparison;
  const lines: string[] = [
    `上一轮（第 ${round} 轮）patcher 候选的修复结果如下。当前工作区是干净基线，尚未包含上一轮改动；请先应用下方上一轮 diff，再针对仍失败的探针/测试继续修（★ 探针只是证据：先判断它的断言是否真的属于契约，再决定是否改代码；验收只由 public 测试决定）★：`
  ];
  for (const channel of ['sci', 'general', 'ds'] as const) {
    const outcome = comparison[channel];
    if (!outcome) {
      continue;
    }
    const verifyFile = path.join(runDir, `verify-result-r${round}-${channel}.json`);
    let block = `- [${channel}]`;
    if (fs.existsSync(verifyFile)) {
      const verify: VerifyResult = JSON.parse(fs.readFileSync(verifyFile, 'utf8'));
      const failed = verify.probe_results.filter((pr) => !pr.passed);
      const alignedCount = verify.probe_results.length - failed.length;
      block += ` 上一轮 verify: ${verify.summary}（参考证据：${alignedCount}/${verify.probe_results.length} 条探针符合预期，★不计入验收★${verify.public_ok ? '，public 复现脚本通过' : ''}）\n`;
      for (const pr of failed) {
        block += `  ${pr.probe_id} 不符预期（${pr.title}）★先归因：是探针读法与任务语义不符，还是代码确实违规★:\n${pr.output.split('\n').map((l) => `    ${l}`).join('\n')}\n`;
      }
    } else {
      block += ` ${outcome.verify.summary}`;
    }
    if (outcome.patch.trim().startsWith('diff')) {
      block += `  上一轮 diff（patch-r${round}-${channel}.diff）:\n${outcome.patch.trimEnd().split('\n').map((l) => `  ${l}`).join('\n')}\n`;
    }
    lines.push(block);
  }
  return lines.join('\n');
}

/** 抓取工作副本相对 HEAD 的 git diff，作为永久工件保存并返回 diff 文本（供 SciReviewer 评审）。 */
async function capturePatch(workspaceRoot: string, runDir: string, name: string): Promise<string> {
  const content = await new Promise<string>((resolve) => {
    execFile('git', ['-C', workspaceRoot, 'diff'], { maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve(
        err
          ? `# 无法获取 git diff（工作区可能不是 git 仓库）：${stderr || err}`
          : (stdout.trim() || '# 本轮 repair 未产生代码改动') + '\n'
      );
    });
  });
  writeArtifact(runDir, `patch-${name}.diff`, content);
  return content;
}

/** 把工作区主目录复制到临时工作副本（排除 .codex-sci-debug；dest 可能嵌套在 source 内，必须用 tar 排除法）。 */
function makeWorkCopy(sourceRoot: string, dest: string): void {
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  execFileSync(
    'sh',
    [
      '-c',
      `tar -C ${JSON.stringify(sourceRoot)} --exclude='./.codex-sci-debug' -cf - . | tar -C ${JSON.stringify(dest)} -xf -`
    ],
    { stdio: 'pipe' }
  );
}

/** 将补丁应用到主工作区：先还原 tracked 文件保证干净基线，再 git apply（普通 + 3way 各试一次）。 */
async function applyPatchToWorkspace(workspaceRoot: string, patchText: string, runDir: string, label: string): Promise<boolean> {
  // git apply 要求 patch 末尾有换行；统一补上，避免截断误报 corrupt patch
  // 注意：只能清理行尾空白，不能整体 trim（diff 末尾的空 context 行是 ' '，trim 会破坏 hunk）
  const patch = patchText + (/\n$/.test(patchText) ? '' : '\n');
  if (!patch.startsWith('diff')) {
    return false;
  }
  const file = path.join(runDir, `patch-to-apply-${label}.diff`);
  fs.writeFileSync(file, patch);
  try {
    execFileSync('git', ['-C', workspaceRoot, 'checkout', '--', '.'], { stdio: 'pipe' });
  } catch {
    // 非 git 仓库：跳过还原
  }
  const argsList = [
    ['-C', workspaceRoot, 'apply', '-p1', '--whitespace=nowarn', file],
    ['-C', workspaceRoot, 'apply', '--3way', '-p1', '--whitespace=nowarn', file]
  ];
  for (const args of argsList) {
    const ok = await new Promise<boolean>((resolve) => {
      execFile('git', args, { maxBuffer: 16 * 1024 * 1024 }, (err) => resolve(!err));
    });
    if (ok) {
      return true;
    }
  }
  return false;
}

/** 只读预检：补丁能否干净地应用到主工作区（不改动工作区）。 */
async function patchAppliesToWorkspace(workspaceRoot: string, patchText: string, name: string): Promise<boolean> {
  const file = path.join(os.tmpdir(), `sci-debug-patchcheck-${name}.diff`);
  fs.writeFileSync(file, patchText + (patchText.endsWith('\n') ? '' : '\n'));
  try {
    return await new Promise<boolean>((resolve) => {
      execFile(
        'git',
        ['-C', workspaceRoot, 'apply', '--check', '-p1', '--whitespace=nowarn', file],
        { maxBuffer: 16 * 1024 * 1024 },
        (err) => resolve(!err)
      );
    });
  } finally {
    fs.rmSync(file, { force: true });
  }
}

/** 自动发现 shot 样例与参考件（任务级作用域优先）：从任务工作区逐级向上搜索。
 *  1) 任务级: shots/<task工作区名>/shot.txt|shot.md 及其目录下其它 diff/patch/md/txt 参考件，
 *     只挂载本任务的 shot 与参考件（避免跨任务污染）；
 *  2) 若 shots/ 已按任务组织（存在 shots/<其它task>/ 目录）但本任务没有 shot，则不挂载任何内容；
 *  3) 回退（shots/ 不存在或未组织）: 挂载最近的通用 shot.txt + shots/ 下全部参考件。 */
export function findShotArtifacts(startDir: string): { shotFile?: string; references: string[] } {
  const root = path.resolve(startDir);
  const taskId = path.basename(root);
  const extFilter = (name: string): boolean => /[.](diff|patch|md|txt)$/i.test(name);
  let scopedShot: string | undefined;
  let scopedDirFound = false;
  let organizedByTask = false;
  let genericShot: string | undefined;
  const scopedRefs: string[] = [];
  const genericRefs: string[] = [];

  let dir = root;
  for (let depth = 0; depth < 12; depth++) {
    const shotsDir = path.join(dir, 'shots');
    if (fs.existsSync(shotsDir) && fs.statSync(shotsDir).isDirectory()) {
      for (const entry of fs.readdirSync(shotsDir, { withFileTypes: true })) {
        const full = path.join(shotsDir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === taskId && !scopedDirFound) {
            scopedDirFound = true;
            for (const name of fs.readdirSync(full)) {
              const refPath = path.join(full, name);
              if (!fs.statSync(refPath).isFile()) continue;
              if (/^shot[.](txt|md)$/i.test(name)) {
                if (scopedShot === undefined) scopedShot = refPath;
              } else if (extFilter(name)) {
                scopedRefs.push(refPath);
              }
            }
          } else {
            organizedByTask = true;
          }
        } else if (extFilter(entry.name)) {
          genericRefs.push(full);
        }
      }
    }
    if (genericShot === undefined) {
      const shotCandidate = path.join(dir, 'shot.txt');
      if (fs.existsSync(shotCandidate)) genericShot = shotCandidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 任务级命中：只挂载本任务的 shot 与参考件
  if (scopedShot !== undefined) {
    scopedRefs.sort();
    return { shotFile: scopedShot, references: scopedRefs };
  }
  // shots/ 已按任务组织但本任务没有 shot：不挂载（避免把其它任务的 shot 污染进本任务）
  if (scopedDirFound || organizedByTask) {
    return { shotFile: undefined, references: [] };
  }
  // 通用回退
  genericRefs.sort();
  return { shotFile: genericShot, references: genericRefs };
}

/** 通用角色 skill 文件发现：从任务工作区逐级向上搜索 <fileName>。
 *  各角色 skill（probe/patcher/reviewer）是任务无关的方法学标准，允许跨任务共享：
 *  1) 任务级优先: shots/<task工作区名>/<fileName>（本任务专属标准）；
 *  2) 共享回退: 任一级目录下的 shots/ 子目录中的 <fileName>、
 *     或 shots/<fileName>、或 <fileName>
 *     （取离任务最近的一个，通常即仓库根的共享标准）。 */
export function findRoleSkillFile(startDir: string, fileName: string): { skillFile?: string } {
  const root = path.resolve(startDir);
  const taskId = path.basename(root);
  let taskScoped: string | undefined;
  const shared: string[] = [];
  let dir = root;
  for (let depth = 0; depth < 12; depth++) {
    const shotsDir = path.join(dir, 'shots');
    if (fs.existsSync(shotsDir) && fs.statSync(shotsDir).isDirectory()) {
      for (const entry of fs.readdirSync(shotsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillPath = path.join(shotsDir, entry.name, fileName);
        if (!fs.existsSync(skillPath)) continue;
        if (entry.name === taskId && taskScoped === undefined) taskScoped = skillPath;
        else shared.push(skillPath);
      }
      const genericInShots = path.join(shotsDir, fileName);
      if (fs.existsSync(genericInShots)) shared.push(genericInShots);
    }
    const direct = path.join(dir, fileName);
    if (fs.existsSync(direct)) shared.push(direct);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 任务级优先；否则回退到最近的共享方法学标准
  const skillFile = taskScoped ?? shared[0];
  return { skillFile };
}

export function findProbeSkill(startDir: string): { skillFile?: string } {
  return findRoleSkillFile(startDir, 'probe_skill.md');
}

export function findPatcherSkill(startDir: string): { skillFile?: string } {
  return findRoleSkillFile(startDir, 'patcher_skill.md');
}

export function findReviewerSkill(startDir: string): { skillFile?: string } {
  return findRoleSkillFile(startDir, 'reviewer_skill.md');
}

/** ★ 只看 public 命令（去预言机化 2026-09-16）★：探针是证据、不是私有测试，因此**不参与**候选选择——
 *  否则「探针通过数」又变成事实上的验收分。public 平局时取先声明者（sci 优先）；全不可用时保持原顺序。 */
function pickByScore(c: MentorComparison): MentorAgentOutcome {
  const score = (o: MentorAgentOutcome): number => {
    return o.verify.public_ok === true ? 1 : 0;
  };
  const candidates: MentorAgentOutcome[] = [c.sci, c.general, c.ds];
  const pool = candidates.filter((o) => o.available);
  const list = pool.length > 0 ? pool : candidates;
  let best = list[0];
  for (const candidate of list) {
    if (score(candidate) > score(best)) best = candidate;
  }
  return best;
}

/** 断点续跑：从上一 run 目录读取三候选 diff，在新副本上 apply + 重新 verify，重建 MentorComparison。 */
async function rebuildComparisonFromPrevious(
  prevDir: string,
  runDir: string,
  options: PipelineOptions,
  probes: Probe[]
): Promise<MentorComparison> {
  const buildOne = async (source: 'sci' | 'general' | 'ds'): Promise<MentorAgentOutcome> => {
    const patchFile = path.join(prevDir, `patch-r1-${source}.diff`);
    let patchText = '';
    try {
      // 原样读取：diff 末尾的空 context 行是单空格行，任何 trim 都会破坏 hunk
      patchText = fs.readFileSync(patchFile, 'utf8');
    } catch {
      patchText = '';
    }
    // 上一 run 的 verify 结果留档到新 run（仅供参考，本次以重新 verify 为准）
    const prevVerifyFile = path.join(prevDir, `verify-result-r1-${source}.json`);
    if (fs.existsSync(prevVerifyFile)) {
      writeArtifact(runDir, `verify-previous-r1-${source}.json`, JSON.parse(fs.readFileSync(prevVerifyFile, 'utf8')));
    }
    writeArtifact(runDir, `patch-r1-${source}.diff`, patchText || '# （断点复用）该候选未交出任何 diff');
    if (!patchText.trimStart().startsWith('diff')) {
      return {
        available: false,
        patch: patchText,
        verify: { ok: false, probe_results: [], summary: `上一 run ${source} 未交出可用 diff，按非阻塞规则仍提交 mentor 终审` }
      };
    }
    const copy = path.join(runDir, 'work', `r1-${source}-resume`);
    makeWorkCopy(options.workspaceRoot, copy);
    const applied = await applyPatchToWorkspace(copy, patchText, runDir, `r1-${source}-resume`);
    const verifyResult = await verify(copy, probes, options.publicCommand, runDir, options.pythonPath);
    writeArtifact(runDir, `verify-result-r1-${source}.json`, verifyResult);
    const checkOk = applied && (await patchAppliesToWorkspace(options.workspaceRoot, patchText, `r1-${source}-resume`));
    if (!checkOk) {
      writeArtifact(runDir, `verify-result-r1-${source}.json`, {
        ...verifyResult,
        ok: false,
        summary: `复用 diff 未通过 git apply --check（可能被截断/损坏），候选标记为不可用（${verifyResult.summary}）`
      });
    }
    return { available: checkOk, patch: patchText, verify: checkOk ? verifyResult : { ...verifyResult, ok: false, summary: `复用 diff 未通过 git apply --check（可能被截断/损坏）` } };
  };
  const [sci, general, ds] = await Promise.all([buildOne('sci'), buildOne('general'), buildOne('ds')]);
  return { sci, general, ds };
}

export async function runPipeline(
  intake: string,
  options: PipelineOptions,
  emit: (event: PipelineEvent) => void
): Promise<RunState> {
  // 单角色模式：patcher/mentor 复用已有 run 目录（与 prober 同一个 runId）；否则新建
  const roleMode = options.onlyStage;
  const reuseDir = options.reuseRunDir ? path.resolve(options.reuseRunDir) : undefined;
  const runId = reuseDir ? path.basename(reuseDir) : new Date().toISOString().replace(/[:.]/g, '-');
  const runDir = reuseDir ?? path.join(options.artifactsRoot, runId);
  fs.mkdirSync(runDir, { recursive: true });
  const activity = makeActivityLogger(runDir, emit);
  const optionsWithActivity: PipelineOptions = {
    ...options,
    onActivity: (text) => activity.record(text)
  };

  let state: RunState;
  const prevStateFile = path.join(runDir, 'run-state.json');
  if (reuseDir && fs.existsSync(prevStateFile)) {
    state = JSON.parse(fs.readFileSync(prevStateFile, 'utf8')) as RunState;
    state.stage = roleMode === 'patcher' ? 'repair' : roleMode === 'mentor' ? 'mentor' : state.stage;
  } else {
    state = { runId, stage: 'intake', retries: 0, failedExperts: [] };
  }
  writeArtifact(runDir, 'intake.md', intake);
  writeArtifact(runDir, 'run-state.json', state);

  // --- probe（断点模式：复用上一 run 的探针报告，跳过专家执行）---
  state.stage = 'probe';
  const resumeDir = options.resumeFromPreviousRunDir;
  // 单角色模式下 patcher/mentor 直接从当前 run 目录读取 prober 产出的探针工件
  const probeSourceDir = roleMode === 'patcher' || roleMode === 'mentor' ? runDir : resumeDir;
  emit({
    type: 'stage',
    stage: 'probe',
    detail: resumeDir ? `断点续跑：复用 ${path.basename(resumeDir)} 的探针报告` : undefined
  });
  const reports: ProbeReport[] = [];
  /** 各 prober 角色在反射轮内实测得到的本底判别结果（确定性诊断证据，不作为门禁）。 */
  const baselineGates: ProbeBaselineGate[] = [];
  if (probeSourceDir) {
    for (const role of options.expertRoles ?? ['tester', 'kimi']) {
      const file = path.join(probeSourceDir, `probe-report-${role}.json`);
      if (fs.existsSync(file)) {
        const report = JSON.parse(fs.readFileSync(file, 'utf8')) as ProbeReport;
        reports.push(report);
        const agentName = PROBER_AGENT_NAMES[role] ?? role;
        writeAgentSelfDecl(runDir, 'prober', agentName, {
          role,
          model: options.expertModels?.[role] ?? '-',
          provider: options.expertProviders?.[role]?.id ?? '-'
        });
        writeArtifact(runDir, `probe-report-${role}.json`, report);
        writeArtifact(runDir, `prober/${agentName}/probe-report-${agentName}.json`, report);
        materializeProbes(runDir, report.probes, `prober/${agentName}/tests`);
        emit({ type: 'report', report });
      } else {
        state.failedExperts.push(role);
      }
    }
    emit({
      type: 'activity',
      text: `📋 断点模式：自 ${path.basename(probeSourceDir)} 复用 ${reports.length} 份探针报告（缺失: ${state.failedExperts.join(', ') || '无'}），跳过专家执行`
    });
    // 自动读取上一 run 物化的探针（probes/manifest.json），保证断点续跑也有可用探针
    if (reports.length === 0) {
      const loaded = loadProbesFromRunDir(probeSourceDir);
      if (loaded.length > 0) {
        const loadedReport: ProbeReport = {
          role: 'resume',
          questions: [],
          exposure_paths: [],
          probes: loaded,
          notes: `auto-loaded ${loaded.length} probes from ${path.basename(probeSourceDir)}/probes`
        };
        reports.push(loadedReport);
        writeArtifact(runDir, 'probe-report-resume.json', loadedReport);
        emit({ type: 'report', report: loadedReport });
        emit({
          type: 'activity',
          text: `📋 断点模式：上一 run 无探针报告 JSON，自动读取物化探针 ${loaded.length} 个（probes/manifest.json）`
        });
      }
    }
  } else {
    // 自动加载 probe skill 标准（任务级 shots/<task>/probe_skill.md 优先，通用回退）
    const probeSkillArtifact = findProbeSkill(options.workspaceRoot);
    const probeSkill = probeSkillArtifact.skillFile
      ? fs.readFileSync(probeSkillArtifact.skillFile, 'utf8')
      : undefined;
    if (probeSkillArtifact.skillFile) {
      activity.record(`[probe] 已加载 Probe Skill 标准: ${probeSkillArtifact.skillFile}`);
      emit({ type: 'activity', text: `[probe] 已加载 Probe Skill 标准: ${probeSkillArtifact.skillFile}` });
    }
    // ★ 本底诊断（确定性，非 LLM；★ 不是门禁 ★）：
    // 每个 prober 角色交卷后，把它的探针在**未修复的工作区**上真跑一遍（独立子目录，避免并发串写）。
    // 结果只作为诊断证据回灌反射轮（供 prober 自行判断是否修订）；不剔除探针、不阻断、不影响验收。
    const probeBaseline =
      options.probeBaselineGate === false
        ? undefined
        : async (role: string, probes: Probe[]): Promise<ProbeBaselineGate> => {
            if (probes.length === 0) {
              return {
                ok: false,
                executed: false,
                reason: 'no probes',
                results: [],
                blocking_probes: [],
                excluded_probes: [],
                low_signal_probes: [],
                discriminating: [],
                summary: '无探针，本底诊断不适用',
                feedback: ''
              };
            }
            const gateDir = path.join(runDir, 'baseline-gate', role);
            const gate = await runProbeBaselineGate(options.workspaceRoot, probes, gateDir, options.pythonPath);
            writeArtifact(runDir, `baseline-gate/probe-baseline-gate-${role}.json`, gate);
            activity.record(`[baseline] ${role}: ${gate.summary}`);
            emit({ type: 'activity', text: `🔬 [baseline] 本底判别诊断 ${role}: ${gate.summary}` });
            return gate;
          };
    const expertResults = await runExperts(
      intake,
      { ...optionsWithActivity, timeoutMs: options.expertTimeoutMs ?? 20 * 60 * 1000, rawLogDir: path.join(runDir, 'raw'), rawJsonlDir: path.join(runDir, 'raw') },
      options.expertModels,
      options.expertKeys,
      options.expertProviders,
      options.expertKnowledge,
      options.knowledgeDir,
      (role, status) =>
        emit({ type: 'expert', role, status }),
      options.expertRoles,
      probeSkill,
      probeBaseline
    );
    for (const result of expertResults) {
      if (result.baseline_gate) baselineGates.push(result.baseline_gate);
      if (result.ok && result.report) {
        reports.push(result.report);
        const agentName = PROBER_AGENT_NAMES[result.role] ?? result.role;
        writeAgentSelfDecl(runDir, 'prober', agentName, {
          role: result.role,
          model: options.expertModels?.[result.role] ?? '-',
          provider: options.expertProviders?.[result.role]?.id ?? '-'
        });
        writeArtifact(runDir, `probe-report-${result.role}.json`, result.report);
        writeArtifact(runDir, `prober/${agentName}/probe-report-${agentName}.json`, result.report);
        materializeProbes(runDir, result.report.probes, `prober/${agentName}/tests`);
        emit({ type: 'report', report: result.report });
      } else {
        const failMsg = result.error ? `（${result.error}）` : '（报告 schema 校验失败）';
        state.failedExperts.push(result.role);
        activity.record(`[probe] 专家 ${result.role} 失败${failMsg}`);
        emit({ type: 'activity', text: `📋 [probe] 专家 ${result.role} 失败${failMsg}` });
      }
    }
  }
  writeArtifact(runDir, 'run-state.json', state);
  if (reports.length === 0) {
    emit({
      type: 'activity',
      text: `⚠ 专家未产出有效探针报告（failed: ${state.failedExperts.join(', ')}），按配置不阻塞，继续后续阶段（verify 仅以 public 全量为 gate）`
    });
  }

  // ★ 隐藏契约交付覆盖审计（确定性，非阻塞）：旧版报告标记 legacy，跳过告警 ★
  const coverageAudit = reports.map((rep) => {
    const c = contractCoverage(rep);
    return {
      role: rep.role,
      legacy: c.legacy,
      contracts: c.count,
      kinds: c.counts,
      hasStructureMap: c.hasStructureMap,
      missing: c.missing
    };
  });
  writeArtifact(runDir, 'contract-coverage.json', { quotas: CONTRACT_QUOTAS, reports: coverageAudit });
  const missingRoles = coverageAudit.filter((c) => !c.legacy && c.missing.length > 0);
  if (missingRoles.length > 0) {
    emit({
      type: 'activity',
      text: `⚠ 隐藏契约交付未达标（${missingRoles
        .map((c) => `${c.role}: ${c.missing.join('、')}`)
        .join('；')}），非阻塞，继续后续阶段`
    });
  }
  const merged = mergeReports(reports);
  materializeProbes(runDir, merged.probes);
  materializeContracts(runDir, merged.contracts, merged.chains, '.');

  // ★ 套件级本底诊断（确定性，非 LLM；★ 只是诊断，不剔除、不阻断、不影响验收 ★）★
  // 探针的判别力只在它能判别时成立：本底通过 = 假绿（零判别力），跑不起来 = 坏探针。
  // 这两类探针只被标注为「低信息量证据」并记录在案：仍然物化、仍然保留，不进入任何门禁。
  const disabledGate: ProbeBaselineGate = {
    ok: true,
    executed: false,
    reason: 'disabled',
    results: [],
    blocking_probes: [],
    excluded_probes: [],
    low_signal_probes: [],
    discriminating: [],
    summary: '本底诊断已关闭（probeBaselineGate=false）',
    feedback: ''
  };
  let baselineGate: ProbeBaselineGate;
  if (options.probeBaselineGate === false) {
    baselineGate = disabledGate;
  } else if (baselineGates.length > 0) {
    baselineGate = aggregateProbeBaselineGates(baselineGates);
  } else if (merged.probes.length === 0) {
    baselineGate = { ...disabledGate, reason: 'no probes', summary: '无探针，本底诊断不适用' };
  } else {
    // 断点/复用分支（probe 报告来自上一 run）：反射轮内没有实测证据，这里补跑一次。
    baselineGate = await runProbeBaselineGate(
      options.workspaceRoot,
      merged.probes,
      path.join(runDir, 'baseline-gate', 'all'),
      options.pythonPath
    );
  }
  writeArtifact(runDir, 'probe-baseline-gate.json', baselineGate);
  activity.record(`[baseline] 套件级：${baselineGate.summary}`);
  emit({ type: 'activity', text: `🔬 [baseline] 探针本底诊断（非门禁）：${baselineGate.summary}` });

  // ★ 诊断只记录、不剔除：探针不再是验收门禁，因此没有任何探针需要「清理」★
  const lowSignalIds = baselineGate.low_signal_probes ?? [];
  if (lowSignalIds.length > 0) {
    const flagged = merged.probes.filter((p) => lowSignalIds.includes(p.id));
    const detail = flagged.map((p) => `${p.id}(${p.title})`).join('、');
    activity.record(`[baseline] 低信息量探针 ${flagged.length} 个（仅诊断，未剔除）：${detail}`);
    emit({
      type: 'activity',
      text: `🔎 [baseline] 低信息量探针 ${flagged.length} 个（本底即通过或自身跑不起来；★ 仅诊断、未剔除、不影响验收 ★）：${detail}`
    });
  }
  if (baselineGate.executed && !baselineGate.ok) {
    emit({
      type: 'activity',
      text: `🔎 [baseline] 探针套件判别力不足（${baselineGate.reason}）：★ 这只是诊断，不影响验收 ★；验收只由 public 测试决定，记录见 probe-baseline-gate.json`
    });
  }

  // --- 三 patcher 并行修复 + verify + SciReviewer 终审循环 ---
  if (roleMode === 'probe') {
    state.stage = 'probe-done';
    writeArtifact(runDir, 'run-state.json', state);
    activity.stop();
    emit({
      type: 'finished',
      ok: true,
      summary:
        `SciProber 完成：${reports.length} 份勘查报告、隐藏契约 ${merged.contracts.length} 条（structure_map ${merged.chains.length} 条）、物化探针 ${merged.probes.length} 个（probes/）` +
        `${baselineGate.executed ? `；本底诊断（非门禁）：有判别力 ${baselineGate.discriminating.length} 个、低信息量 ${baselineGate.low_signal_probes?.length ?? 0} 个` : ''}` +
        `；下一步 run_patcher.sh`
    });
    return state;
  }
  const maxRegen = options.mentorMaxRegenerations ?? 1;
  let regenUsed = 0;
  let retryFeedback: string | undefined;
  let lastComparison: MentorComparison | undefined;

  // Patcher 单角色断点重跑：复用 run 目录时自动把上一轮候选 diff 与探针反馈注入 prompt
  if (roleMode === 'patcher' && reuseDir) {
    retryFeedback = buildPrevRoundPatcherFeedback(runDir);
    if (retryFeedback) {
      emit({ type: 'activity', text: `[patcher] 检测到复用 run 目录中的上一轮产物，已将上一轮 diff 与探针反馈注入本轮 prompt` });
    }
  }

  const sciRole = 'domain-invariant';
  const knowledgeBlock = [
    options.expertKnowledge?.[sciRole]?.trim()
      ? `=== 领域知识清单（SciPatcher） ===\n${options.expertKnowledge[sciRole].trim()}\n`
      : '',
    options.knowledgeDir?.trim()
      ? `开始前请先阅读 ${options.knowledgeDir.trim()} 目录下的领域知识文档（只读），只取与当前 bug class 相关的部分作为参考。`
      : ''
  ]
    .filter(Boolean)
    .join('\n');
  // 自动加载 patcher skill 方法学标准（任务级 shots/<task>/patcher_skill.md 优先，通用回退）
  const patcherSkillArtifact = findPatcherSkill(options.workspaceRoot);
  const patcherSkill = patcherSkillArtifact.skillFile
    ? fs.readFileSync(patcherSkillArtifact.skillFile, 'utf8')
    : undefined;
  if (patcherSkillArtifact.skillFile) {
    activity.record(`[patcher] 已加载 Patcher Skill 标准: ${patcherSkillArtifact.skillFile}`);
    emit({ type: 'activity', text: `[patcher] 已加载 Patcher Skill 标准: ${patcherSkillArtifact.skillFile}` });
  }
  const patcherSkillBlock = patcherSkill
    ? `\n=== Patcher Skill 方法学标准（必须遵循：contract 先行、evidence 驱动、最小改动）===\n${patcherSkill.trim()}\n`
    : '';
  const sciFraming = `你是 "SciPatcher"（科学补丁专家，领域不变量背景，专精生化/量子化学计算代码，配备领域知识库）。
${knowledgeBlock}${patcherSkillBlock}`.trim();
  const generalFraming = `你是 "SciPatcher"（通用科学补丁专家，无领域知识库）。${patcherSkillBlock}`.trim();
  const dsFraming = `你是 "SciPatcher"（通用科学补丁专家，通用补丁通道，无领域知识库）。${patcherSkillBlock}`.trim();

  const finishWithPatch = async (source: string, patchText: string, note: string): Promise<void> => {
    const applied = await applyPatchToWorkspace(options.workspaceRoot, patchText, runDir, source);
    writeArtifact(runDir, 'chosen-patch.json', { source, note, applied });
    state.stage = 'verify';
    emit({ type: 'stage', stage: 'verify', detail: `最终验证（补丁来源：${source}）` });
    const finalVerify = await verify(options.workspaceRoot, merged.probes, options.publicCommand, runDir, options.pythonPath);
    writeArtifact(runDir, 'verify-final.json', finalVerify);
    state.verifySummary = finalVerify.summary;
    state.patchSummary = patchText.slice(-2000);
    state.stage = applied && finalVerify.ok ? 'done' : 'failed';
    writeArtifact(runDir, 'run-state.json', state);
    activity.stop();
    emit({
      type: 'finished',
      ok: applied && finalVerify.ok,
      summary: applied ? finalVerify.summary : `最终补丁（${source}）无法应用到主工作区。${note}`
    });
  };

  /** 统一"修补打磨"兜底：按规则（verdict 规则 → 逐维评分进度 → verify 得分）选定更优候选，
   *  在其基础 diff 之上做最小改动打磨；当所有候选补丁均不可用/不可应用时硬失败（返回 false）。 */
  const mentorPolishFallback = async (
    comparison: MentorComparison,
    guidance: string,
    round: number,
    verdict?: MentorVerdict,
    progressFile?: string
  ): Promise<boolean> => {
    let selection: MentorPolishSelection | null = null;
    let selectionSource = '';
    if (verdict) {
      const rule = resolveMentorSelection(verdict, comparison);
      if (rule.source === 'sci' || rule.source === 'general' || rule.source === 'ds') {
        const outcome = rule.source === 'sci' ? comparison.sci : rule.source === 'general' ? comparison.general : comparison.ds;
        if (outcome.available && outcome.patch.trim().startsWith('diff')) {
          const label = rule.source === 'sci' ? 'candidate_1' : rule.source === 'general' ? 'candidate_2' : 'candidate_3';
          const entry = (verdict.evaluation ?? []).find((e) => e.candidate === label);
          selection = {
            source: rule.source,
            candidateLabel: label,
            baseDiff: outcome.patch,
            scores: entry?.scores ?? { functional: 0, numerical: 0, scientific: 0, robustness: 0, intent: 0, quality: 0 },
            weighted: entry ? mentorWeightedScore(entry.scores) : 0,
            note: `终审规则选择：${rule.note}`
          };
          selectionSource = 'verdict 规则';
        }
      }
    }
    if (!selection && progressFile && fs.existsSync(progressFile)) {
      try {
        const lines = parseMentorProgressLines(fs.readFileSync(progressFile, 'utf8'));
        const fromProgress = resolvePolishSelectionFromProgress(lines, comparison);
        if (fromProgress) {
          selection = fromProgress;
          selectionSource = '逐维评分进度';
        }
      } catch {
        activity.record('[mentor-polish] 进度文件不可读，继续走 verify 得分终极兜底');
      }
    }
    if (!selection) {
      selection = resolvePolishTargetByVerify(comparison);
      selectionSource = 'verify 得分（终极兜底）';
    }
    if (!selection) {
      state.stage = 'failed';
      writeArtifact(runDir, 'run-state.json', state);
      activity.stop();
      emit({
        type: 'finished',
        ok: false,
        summary: '所有候选补丁均不可应用（diff 不可用或不可应用），无法确定修补打磨对象'
      });
      return false;
    }
    const polishCopy = path.join(runDir, 'work', `r${round + 1}-mentor-polish`);
    makeWorkCopy(options.workspaceRoot, polishCopy);
    const baseApplied = await applyPatchToWorkspace(polishCopy, selection.baseDiff, runDir, `r${round + 1}-polish-base`);
    if (!baseApplied) {
      const fallback = pickByScore(comparison);
      const source = fallback === comparison.sci ? 'sci' : fallback === comparison.general ? 'general' : 'ds';
      activity.record(`[mentor-polish] ${selection.candidateLabel} 基础 diff 无法应用，回退按 verify 得分确定性选择（${selectionSource}）`);
      await finishWithPatch(source, fallback.patch, `更优候选基础 diff（${selectionSource}）无法应用，按 verify 得分确定性选择；${selection.note}`);
      return true;
    }
    const polishedRun = await runMentorPolish(
      intake,
      merged.probes,
      options.publicCommand,
      comparison,
      selection,
      {
        codexPath: options.codexPath,
        model: options.mentorModel || options.model,
        sandbox: 'danger-full-access',
        cwd: polishCopy,
        apiKey: options.mentorKey,
        provider: options.mentorProvider,
        shotContent,
        shotReferenceFiles,
        reviewerSkillContent,
        progressSummary: progressFile && fs.existsSync(progressFile) ? fs.readFileSync(progressFile, 'utf8').trim() || undefined : undefined,
        guidance: guidance || undefined,
        timeoutMs: options.mentorPolishTimeoutMs ?? options.mentorTimeoutMs ?? 60 * 60 * 1000,
        onActivity: (text) => activity.record(`[mentor-polish] ${text}`)
      }
    );
    if (polishedRun.ok) {
      writeArtifact(runDir, `repair-response-r${round + 1}-mentor-polish.md`, polishedRun.text);
      const polishedDiff = await capturePatch(polishCopy, runDir, `r${round + 1}-mentor-polish`);
      if (polishedDiff.trim().startsWith('diff') && (await patchAppliesToWorkspace(options.workspaceRoot, polishedDiff, `r${round + 1}-mentor-polish`))) {
        if (polishedDiff.trim() === selection.baseDiff.trim()) {
          activity.record(`[mentor-polish] 打磨会话未在基础补丁上产生任何改动（最终 diff 与基础 diff 一致），直接采用基础 diff；如需真正打磨请检查执行纪律约束后重跑 run_mentor.sh`);
          emit({ type: 'activity', text: `⚠ SciReviewer 打磨会话未产生改动，采用 ${selection.candidateLabel} 基础 diff 原样` });
        }
        writeArtifact(runDir, `patch-r${round + 1}-mentor-polished.diff`, polishedDiff);
        await finishWithPatch('mentor-polished', polishedDiff, `按${selectionSource}选定 ${selection.candidateLabel} 并修补打磨出最终补丁；${selection.note}`);
        return true;
      }
      activity.record(`[mentor-polish] ${selection.candidateLabel} 基础 diff 之上的打磨补丁无效或未通过 git apply --check，回退使用其基础 diff`);
    }
    if (await patchAppliesToWorkspace(options.workspaceRoot, selection.baseDiff, `r${round + 1}-polish-base-final`)) {
      await finishWithPatch(selection.source, selection.baseDiff, `修补打磨未产出有效补丁，直接采用 ${selection.candidateLabel} 基础 diff（${selectionSource}）；${selection.note}`);
      return true;
    }
    const fallback = pickByScore(comparison);
    const source = fallback === comparison.sci ? 'sci' : fallback === comparison.general ? 'general' : 'ds';
    await finishWithPatch(source, fallback.patch, `更优候选基础 diff（${selectionSource}）无法应用，按 verify 得分确定性选择；${selection.note}`);
    return true;
  };

  // 自动加载 shot 样例 + 参考件：任务工作区或其任意上级目录存在 shot.txt / shots/ 时，挂载进 mentor 评分/修补打磨 prompt
  const shotArtifacts = findShotArtifacts(options.workspaceRoot);
  const shotFile = shotArtifacts.shotFile;
  const shotReferenceFiles = shotArtifacts.references;
  const shotContent = shotFile ? fs.readFileSync(shotFile, 'utf8') : undefined;
  // 自动加载 reviewer skill 方法学标准（注入 SciReviewer 评审/修补打磨 prompt）
  const reviewerSkillArtifact = findReviewerSkill(options.workspaceRoot);
  const reviewerSkillContent = reviewerSkillArtifact.skillFile
    ? fs.readFileSync(reviewerSkillArtifact.skillFile, 'utf8')
    : undefined;
  if (reviewerSkillArtifact.skillFile) {
    activity.record(`[mentor] 已加载 Reviewer Skill 标准: ${reviewerSkillArtifact.skillFile}`);
    emit({ type: 'activity', text: `[mentor] 已加载 Reviewer Skill 标准: ${reviewerSkillArtifact.skillFile}` });
  }
  if (shotContent) {
    activity.record(`[mentor] 已加载 shot 样例: ${shotFile}`);
    emit({ type: 'activity', text: `[mentor] 已加载 shot 样例: ${shotFile}` });
  }
  if (shotReferenceFiles.length > 0) {
    activity.record(`[mentor] 已发现 shot 参考件: ${shotReferenceFiles.join(', ')}`);
    emit({ type: 'activity', text: `[mentor] 已发现 shot 参考件: ${shotReferenceFiles.join(', ')}` });
  }

  for (let round = 0; round <= options.maxRetries; round++) {
    // 单角色模式下 mentor 从同一 run 目录复用 patcher 的三候选 diff；legacy 断点续跑则读上一 run 目录
    const comparisonSourceDir = roleMode === 'mentor' ? runDir : options.resumeFromPreviousRunDir;
    const resumeThisRound = round === 0 && !!comparisonSourceDir;
    state.stage = resumeThisRound ? 'mentor' : 'repair';
    emit({
      type: 'stage',
      stage: resumeThisRound ? 'mentor' : 'repair',
      detail: resumeThisRound ? '断点续跑：跳过 probe/repair，直接进入 mentor 终审' : `第 ${round + 1} 轮`
    });

    const runOneDebugger = async (
      source: 'sci' | 'general' | 'ds',
      copy: string,
      framing: string,
      model?: string,
      key?: string,
      provider?: ModelProviderConfig
    ): Promise<MentorAgentOutcome> => {
      const resumeThreadId = options.expertResumeThreadIds?.[source];
      if (resumeThreadId) {
        activity.record(
          `[repair:${source}] 断点续跑：恢复上一轮会话 ${resumeThreadId}（沿用其上轮上下文，非全新会话）`
        );
        emit({ type: 'activity', text: `[repair:${source}] 断点续跑：恢复会话 ${resumeThreadId}` });
      }
      const agent = await runCodexOnce(
        buildRepairPrompt(intake, reports, retryFeedback, framing, options.repairTimeoutMs, baselineGate),
        {
          ...optionsWithActivity,
          sandbox: 'danger-full-access',
          cwd: copy,
          model: model || options.repairModel || options.model,
          apiKey: key,
          provider,
          resumeThreadId,
          rawLogPath: path.join(runDir, 'raw', `patcher-r${round + 1}-${source}.raw.txt`),
          timeoutMs: options.repairTimeoutMs ?? 60 * 60 * 1000,
          onActivity: (text) => activity.record(`[repair:${source}] ${text}`)
        }
      );
      // 强制交卷语义：无论会话成功/超时/失败，都强制捕获工作副本里已写出的 diff；
      // 只有「会话失败且没有捕获到任何 diff」的候选才标记不可用
      const responseText = agent.ok ? agent.text : `(会话失败：${agent.error}) 无响应文本，强制交卷`;
      writeArtifact(runDir, `repair-response-r${round + 1}-${source}.md`, responseText);
      // 同步镜像到 patcher 角色文件夹（自名子目录，供人工审查；legacy 顶层工件保留）
      const patcherAgent = PATCHER_AGENT_NAMES[source] ?? source;
      writeArtifact(runDir, `patcher/${patcherAgent}/repair-response-r${round + 1}.md`, responseText);
      const patchText = await capturePatch(copy, runDir, `r${round + 1}-${source}`);
      const capturedDiff = patchText.trim().startsWith('diff');
      if (capturedDiff) {
        emit({
          type: 'patch',
          round: round + 1,
          source,
          path: path.join(runDir, `patch-r${round + 1}-${source}.diff`)
        });
        const verifyResult = await verify(copy, merged.probes, options.publicCommand, runDir, options.pythonPath);
        writeArtifact(runDir, `verify-result-r${round + 1}-${source}.json`, verifyResult);
        writeArtifact(runDir, `patcher/${patcherAgent}/patch-r${round + 1}.diff`, patchText);
        writeArtifact(runDir, `patcher/${patcherAgent}/verify-result-r${round + 1}.json`, verifyResult);
        if (!(await patchAppliesToWorkspace(options.workspaceRoot, patchText, `r${round + 1}-${source}`))) {
          // 防御 corrupt patch：强制交卷时截断的 diff 同样可能不完整，不能进后续 apply。
          activity.record(`[repair:${source}] 捕获的 diff 未通过 git apply --check 校验（疑似编辑被截断），该候选标记为不可用`);
          return {
            available: false,
            patch: patchText,
            verify: { ok: false, probe_results: [], summary: '捕获的 diff 未通过 git apply --check（patcher 编辑可能被截断）' }
          };
        }
        if (!agent.ok) {
          activity.record(`[repair:${source}] 会话失败（${agent.error}）但已强制捕获 diff，作为候选进入 mentor 评审`);
        }
        return { available: true, patch: patchText, verify: verifyResult };
      }
      if (!agent.ok) {
        return {
          available: false,
          patch: '',
          verify: { ok: false, probe_results: [], summary: `patcher 会话失败：${agent.error}；强制交卷未捕获到任何 diff` }
        };
      }
      // 会话正常结束但没产出 diff：仍跑一次 verify 留痕，候选标记不可用
      const emptyVerify = await verify(copy, merged.probes, options.publicCommand, runDir, options.pythonPath);
      writeArtifact(runDir, `verify-result-r${round + 1}-${source}.json`, emptyVerify);
      writeArtifact(runDir, `patcher/${patcherAgent}/verify-result-r${round + 1}.json`, emptyVerify);
      return {
        available: false,
        patch: '',
        verify: { ok: false, probe_results: [], summary: '会话结束但未产出 diff' }
      };
    };

    let comparison: MentorComparison;
    if (resumeThisRound) {
      // 断点模式：复用已有 run 的三候选 diff（含截断/不可用），重新 verify 后全部喂给 mentor
      comparison = await rebuildComparisonFromPrevious(comparisonSourceDir!, runDir, optionsWithActivity, merged.probes);
      activity.record('[resume] 复用上一 run 三候选 diff 构建 comparison（含不可用候选），全部进入 mentor 评审');
    } else {
      const sciCopy = path.join(runDir, 'work', `r${round + 1}-sci`);
      const generalCopy = path.join(runDir, 'work', `r${round + 1}-general`);
      const dsCopy = path.join(runDir, 'work', `r${round + 1}-ds`);
      // ★ 断点续跑通道：保留上一轮的工作副本（连同其诊断脚本、复现报告等中间产物），
      // 让被恢复的会话看到自己上轮的现场，而不是一块被清空的地基 ★
      const repairCopies: Array<['sci' | 'general' | 'ds', string]> = [
        ['sci', sciCopy],
        ['general', generalCopy],
        ['ds', dsCopy]
      ];
      for (const [source, copyDir] of repairCopies) {
        if (options.expertResumeThreadIds?.[source] && fs.existsSync(copyDir)) {
          activity.record(`[repair:${source}] 断点续跑：沿用上一轮工作副本 ${copyDir}（不重建，保留中间产物）`);
          continue;
        }
        makeWorkCopy(options.workspaceRoot, copyDir);
      }
      // ★ patcher 自验证：把合并探针物化进各工作副本 verify/probes/，供 patcher 参考运行 prober 提出的探针（★ 证据，不是验收标准 ★）★
      for (const repairCopy of [sciCopy, generalCopy, dsCopy]) {
        materializeProbes(repairCopy, merged.probes, 'verify/probes');
        materializeContracts(repairCopy, merged.contracts, merged.chains, 'verify');
      }
      // 角色文件夹约定：每个 patcher 运行前先写自名声明 patcher/<name>/<name>.md
      writeAgentSelfDecl(runDir, 'patcher', PATCHER_AGENT_NAMES.sci, {
        role: 'domain-invariant',
        model: options.expertModels?.[sciRole] ?? '-',
        provider: options.expertProviders?.[sciRole]?.id ?? '-'
      });
      writeAgentSelfDecl(runDir, 'patcher', PATCHER_AGENT_NAMES.general, {
        role: 'repair',
        model: options.repairModel || options.model || '-',
        provider: options.repairProvider?.id ?? '-'
      });
      writeAgentSelfDecl(runDir, 'patcher', PATCHER_AGENT_NAMES.ds, {
        role: 'ds',
        model: options.expertModels?.['ds'] ?? '-',
        provider: options.expertProviders?.['ds']?.id ?? '-'
      });

      // ★ 通道子集策略（如 ds-only）：未启用通道不走会话，以 skipped 占位结果记录，不阻塞后续 ★
      const enabledRepairRoles = options.onlyRepairRoles ?? ['sci', 'general', 'ds'];
      const repairEnabled = (s: 'sci' | 'general' | 'ds'): boolean => enabledRepairRoles.includes(s);
      const skippedRepair = (source: 'sci' | 'general' | 'ds'): MentorAgentOutcome => ({
        available: false,
        patch: '',
        verify: { ok: false, probe_results: [], summary: `${source} 通道未运行（仅启用 ${enabledRepairRoles.join(', ')} 通道）` }
      });
      if (enabledRepairRoles.length === 0) {
        throw new Error('onlyRepairRoles 为空：至少启用一个 patcher 通道');
      }
      emit({
        type: 'activity',
        text: `⚙ repair 通道子集：启用 [${enabledRepairRoles.join(', ')}]，未启用通道以 skipped 占位记录`
      });
      const [sciOutcome, generalOutcome, dsOutcome] = await Promise.all([
        repairEnabled('sci')
          ? runOneDebugger(
              'sci',
              sciCopy,
              sciFraming,
              options.expertModels?.[sciRole],
              options.expertKeys?.[sciRole],
              options.expertProviders?.[sciRole]
            )
          : Promise.resolve(skippedRepair('sci')),
        repairEnabled('general')
          ? runOneDebugger('general', generalCopy, generalFraming)
          : Promise.resolve(skippedRepair('general')),
        repairEnabled('ds')
          ? runOneDebugger(
              'ds',
              dsCopy,
              dsFraming,
              options.expertModels?.['ds'],
              options.expertKeys?.['ds'],
              options.expertProviders?.['ds']
            )
          : Promise.resolve(skippedRepair('ds'))
      ]);

      // ★ 非阻塞规则：无论 repair 是否失败（即使候选都不可用），都不终止流水线；
      // 全部候选（含未完成/被截断的 diff）都喂给 mentor 评审；未启用通道（skipped）不计入失败统计
      const enabledOutcomes = (['sci', 'general', 'ds'] as const)
        .filter((s) => repairEnabled(s))
        .map((s) => (s === 'sci' ? sciOutcome : s === 'general' ? generalOutcome : dsOutcome));
      if (enabledOutcomes.length > 0 && enabledOutcomes.every((o) => !o.available)) {
        emit({
          type: 'activity',
          text: `⚠ 启用的 patcher 通道均未产出可用 diff（${enabledOutcomes.map((o) => o.verify.summary).join('；')}），按规则不阻塞，强制进入 SciReviewer 终审`
        });
        activity.record('[mentor] 启用通道候选均不可用，强制进入 SciReviewer 终审');
      }

      comparison = { sci: sciOutcome, general: generalOutcome, ds: dsOutcome };
    }
    lastComparison = comparison;
    writeArtifact(runDir, `comparison-r${round + 1}.json`, comparison);

    if (roleMode === 'patcher') {
      state.stage = 'patcher-done';
      state.retries = round;
      writeArtifact(runDir, 'run-state.json', state);
      activity.stop();
      emit({
        type: 'finished',
        ok: true,
        summary: `SciPatcher 完成：第 ${round + 1} 轮三候选 diff 与 verify 结果已落盘（comparison-r${round + 1}.json）；下一步 run_mentor.sh`
      });
      return state;
    }

    // --- SciReviewer LLM 终审（verify 之后，对比两个补丁） ---
    state.stage = 'mentor';
    emit({ type: 'stage', stage: 'mentor', detail: `第 ${round + 1} 轮` });
    // 逐步评分：mentor 在独立 scratch 目录（workspace-write）写 JSONL 进度文件，主工作区保持只读
    const mentorScratch = path.join(runDir, 'work', `r${round + 1}-mentor-scores`);
    fs.mkdirSync(mentorScratch, { recursive: true });
    const mentorProgressFile = path.join(mentorScratch, 'mentor-scores-progress.jsonl');
    const mentor = await runMentor(intake, merged.probes, options.publicCommand, comparison, {
      codexPath: options.codexPath,
      model: options.mentorModel || options.model,
      sandbox: 'danger-full-access',
      cwd: mentorScratch,
      workspaceRoot: options.workspaceRoot,
      progressFile: mentorProgressFile,
      shotContent,
      shotReferenceFiles,
      apiKey: options.mentorKey,
      provider: options.mentorProvider,
      timeoutMs: options.mentorTimeoutMs ?? 20 * 60 * 1000,
      onActivity: (text) => activity.record(`[mentor] ${text}`)
    });
    if (fs.existsSync(mentorProgressFile)) {
      writeArtifact(runDir, `mentor-progress-r${round + 1}.jsonl`, fs.readFileSync(mentorProgressFile, 'utf8').trimEnd());
    }
    writeArtifact(runDir, `mentor-verdict-r${round + 1}.json`, mentor);

    if (mentor.ok && mentor.verdict) {
      const verdict = mentor.verdict;
      if (verdict.verdict === 'accept') {
        // rubric 评价报告：存在 evaluation 时落盘人类可读工件（逐候选六维打分 + CSE + 加权分）
        if (Array.isArray(verdict.evaluation) && verdict.evaluation.length > 0) {
          writeArtifact(runDir, `mentor-evaluation-r${round + 1}.md`, renderMentorEvaluationMarkdown(verdict));
        }
        let sourceLabel: string;
        let patchToApply: string;
        let note: string;
        if (verdict.choice === 'synthesized') {
          const synthesized = (verdict.patch ?? '').trim();
          if (synthesized.startsWith('diff')) {
            sourceLabel = 'synthesized';
            patchToApply = synthesized;
            note = 'SciReviewer 合成三个候选生成更优补丁';
          } else {
            // 合成补丁不是有效 diff：★不阻塞★，强制转 SciReviewer 按规则选优 + 修补打磨
            await mentorPolishFallback(comparison, verdict.guidance, round, verdict, mentorProgressFile);
            return state;
          }
        } else {
          // ★ rubric 硬约束 + 加权分选择：CSE 过滤 → 加权 argmax（代码侧计算）；无 evaluation 时回退 LLM 声明的 choice
          const selection = resolveMentorSelection(verdict, comparison);
          if (selection.source === 'regenerate') {
            // CSE 过滤掉全部候选（或无可用候选）：按打回处理
            const reason = `SciReviewer 打回（rubric 硬约束）：${selection.note}`;
            emit({ type: 'mentor', round: round + 1, verdict: 'regenerate', summary: reason, choice: 'regenerate' });
            if (regenUsed < maxRegen && roleMode !== 'mentor') {
              regenUsed += 1;
              state.retries = round + 1;
              retryFeedback = buildDualRetryFeedback(
                [...verdict.semantic_issues, ...selection.filteredOut],
                verdict.guidance,
                comparison
              );
              writeArtifact(runDir, 'run-state.json', state);
              emit({ type: 'retry', round: round + 1, reason });
              continue;
            }
            await mentorPolishFallback(comparison, verdict.guidance, round, verdict, mentorProgressFile);
            return state;
          }
          const chosen = selection.source === 'sci' ? comparison.sci : selection.source === 'general' ? comparison.general : comparison.ds;
          sourceLabel = selection.source;
          patchToApply = chosen.patch;
          note = selection.note;
          // ★ 新方法：SciReviewer 在所选候选之上修补打磨，产出 patch；先 git apply --check 校验，失败回退原始候选 diff
          const polished = (verdict.patch ?? '').trim();
          if (polished.startsWith('diff') && polished !== chosen.patch.trim()) {
            const polishCopy = path.join(runDir, 'work', `r${round + 1}-polish-check`);
            makeWorkCopy(options.workspaceRoot, polishCopy);
            if (await patchAppliesToWorkspace(polishCopy, polished, `r${round + 1}-polish`)) {
              sourceLabel = 'mentor-polished';
              patchToApply = polished;
              note = `SciReviewer 打分→打磨：胜者 ${selection.source}，采用打磨后最终补丁；${selection.note}`;
            } else {
              activity.record(`[mentor] 打磨补丁未通过 git apply --check，回退使用原始 ${selection.source} 候选 diff`);
              emit({ type: 'activity', text: `⚠ SciReviewer 打磨补丁未通过 git apply --check，回退原始 ${selection.source} 候选` });
            }
          } else if (!chosen.available || !chosen.verify.ok) {
            // 无可用打磨补丁且所选候选不可用/未过 verify：★不阻塞★，强制转 SciReviewer 按规则选优 + 修补打磨
            await mentorPolishFallback(comparison, verdict.guidance, round, verdict, mentorProgressFile);
            return state;
          }
        }
        emit({ type: 'mentor', round: round + 1, verdict: 'accept', summary: note, choice: sourceLabel });
        if (sourceLabel === 'synthesized' || sourceLabel === 'mentor-polished') {
          writeArtifact(runDir, `patch-r${round + 1}-${sourceLabel}.diff`, patchToApply);
          emit({
            type: 'patch',
            round: round + 1,
            source: 'mentor',
            path: path.join(runDir, `patch-r${round + 1}-${sourceLabel}.diff`)
          });
        }
        await finishWithPatch(sourceLabel, patchToApply, note);
        return state;
      }

      const reason = `SciReviewer 打回：${verdict.semantic_issues.join('；') || '存在语义退化'}`;
      emit({ type: 'mentor', round: round + 1, verdict: 'regenerate', summary: reason, choice: 'regenerate' });
      if (regenUsed < maxRegen && roleMode !== 'mentor') {
        regenUsed += 1;
        state.retries = round + 1;
        retryFeedback = buildDualRetryFeedback(verdict.semantic_issues, verdict.guidance, comparison);
        writeArtifact(runDir, 'run-state.json', state);
        emit({ type: 'retry', round: round + 1, reason });
        continue;
      }
      await mentorPolishFallback(comparison, verdict.guidance, round, verdict, mentorProgressFile);
      return state;
    }

    // SciReviewer 选择阶段未产出裁决（会话失败或 schema 不合格）：统一"修补打磨"兜底：
    // 按规则（verdict 规则 → 逐维评分进度 → verify 得分）选定更优候选，在其基础 diff 上修补打磨；
    // 仅当所有候选补丁均不可应用（打磨后亦无有效补丁）才是硬失败
    emit({
      type: 'mentor',
      round: round + 1,
      verdict: 'error',
      summary: `SciReviewer 会话不可用（${mentor.error ?? '未知原因'}）；按规则选定更优候选并修补打磨`
    });
    await mentorPolishFallback(comparison, '', round, undefined, mentorProgressFile);
    return state;
  }

  // 理论上不可达（每轮要么 return 要么已触发按规则选优 + 修补打磨）；兜底：规则选优 + 修补打磨
  if (lastComparison) {
    await mentorPolishFallback(lastComparison, '', options.maxRetries);
    return state;
  }
  state.stage = 'failed';
  writeArtifact(runDir, 'run-state.json', state);
  activity.stop();
  emit({ type: 'finished', ok: false, summary: '三个 patcher 均失败，无法产出补丁。' });
  return state;
}
