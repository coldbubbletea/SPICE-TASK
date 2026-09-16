import * as fs from 'fs';
import * as path from 'path';
import { CodexRunOptions, ModelProviderConfig, runCodexOnce } from './runner';
import {
  CONTRACT_QUOTAS,
  ContractCoverage,
  Probe,
  ProbeBaselineGate,
  ProbeReport,
  contractCoverage,
  extractJson,
  validateProbeReport
} from './schemas';
import {
  ACCEPTANCE_SCOPE_CLAUSE,
  CONTRACT_COMPLETENESS_CLAUSE,
  HIDDEN_CONTRACT_QUOTA_CLAUSE,
  PROBE_AS_EVIDENCE_CLAUSE
} from '../orchestrator/promptClauses';

export interface ExpertResult {
  role: string;
  ok: boolean;
  report?: ProbeReport;
  error?: string;
  /** 通过 schema 校验但隐藏契约交付未达标的项（非阻塞，orchestrator 记录告警）。 */
  coverage_missing?: string[];
  /** 隐藏契约交付覆盖审计（确定性；非阻塞）。 */
  contract_coverage?: ContractCoverage;
  /** 交付前在未修复本底上的实测判别结果（确定性诊断，非 LLM；不构成验收门禁）。 */
  baseline_gate?: ProbeBaselineGate;
}

const REPORT_SCHEMA_HINT = `
你的最终回复必须只包含一个 JSON 对象（可用 markdown 代码围栏），schema 如下：
{
  "role": "<你的角色名>",
  "hidden_contracts": [
    {
      "id": "HC1",
      "statement": "一句话陈述这条隐藏契约（可复核/可证伪的行为断言，不是泛泛而谈）",
      "kind": "invariant|precondition|postcondition|unit_convention|ordering|error_semantics|naming_alias|data_shape|numerical_tolerance|resource_lifecycle",
      "locus": "file:symbol（可带 :line）——契约生效/被依赖的位置",
      "enforced_by": "谁在守护它：承载该约定的代码/数据结构/文档/公开材料（可空）",
      "discovered_via": "你是怎么发现它的（调用点并置 / 数据结构自洽 / 两条路径必须同结果 / 异常边界 / 单位与 axis 约定 / 公开材料与实现对照）",
      "evidence": "file:line 引用 / 文档原文 / 你自己的实测输出（★ 禁止「我认为」「我推测」）",
      "scope": "哪些入口 / 参数 / 运行模式受这条契约约束",
      "violates_if": "什么样的修复会破坏它（反例风险）——这是给 patcher 最有价值的信息",
      "confidence": 0.4,
      "open_question": "仍未决、只能以问题形式提出的语义（确定时写 "无"）",
      "patcher_action": "要求 patcher 独立核实/必须保留的具体事项（1-3 句）",
      "probe_ids": ["p1"]
    }
  ],
  "structure_map": [
    {
      "entry": "file:symbol（公开入口）",
      "chain": "file:symbol → file:symbol → … → 契约生效/被违反的站点",
      "termination": "这条链的终点说明了什么（契约在哪一步被依赖/破坏）",
      "siblings": ["共享同一契约、必须一并评估的兄弟调用点 file:symbol"],
      "note": "备注（可选）"
    }
  ],
  "probes": [
    {
      "id": "p1",
      "title": "探针名",
      "kind": "python|shell",
      "code": "可执行测试代码",
      "expect": "你**预测**的修复后行为（证据，不是验收标准）",
      "confidence": 0.42,
      "open_question": "此处仍不确定、只能作为问题提出的语义（必填，确定无疑时写 "无"）",
      "dimension": "main_path|param_space|name_variants|robustness|api_surface",
      "patcher_guidance": "出题意图与给 patcher 的修复注意点（1-3 句；作为可错的一家之言提供给 patcher）"
    }
  ],
  "coverage_matrix": {"main_path": ["p1"]},
  "questions": ["你提出的关键问题"],
  "exposure_paths": [{"file": "相对路径", "symbol": "函数/类名", "how": "该入口如何触发这个 bug class"}],
  "notes": "其他发现（可选）"
}

规则：
- ★ 你的第一交付物是 hidden_contracts + structure_map，不是探针 ★：
  · 隐藏契约 = 这份代码里「没有写在签名/文档里、但被多处调用点共同依赖」的行为约定。
    最低交付：hidden_contracts ≥ 3 条、至少覆盖 2 种不同的 kind、structure_map ≥ 2 条入口链。
  · 每条契约必须有可复核证据（evidence 必须是 file:line / 文档原文 / 你的实测输出），必须写 violates_if，
    必须写 confidence(0–1) 与 open_question；patcher_action 要说清 patcher 必须独立核实什么。
  · structure_map 要把「公开入口 → 逐跳调用 → 契约站点 → 兄弟调用点」画出来；兄弟调用点是关键：
    共享同一契约的其它调用点，只改一处就是漏修。
  · ★ 契约同样是「可错的一家之言」★：不要写「这就是正确的读法」，要写「我基于 X 认为……置信度 0.…，patcher 需核实 Y」。
- 你是只读分析者：禁止修改任何被测代码文件
- ★ 你不是预言机 ★：你产出的任何内容（契约、结构图、探针、kill line、排名）都是假设与线索，不是验收门禁、
  不是私有测试。禁止使用「修复后必须通过 / 必须全部转绿 / 这就是官方验收 / 只有这一种读法正确」这类措辞。
  最终裁决权在 patcher 的实测与 public 测试。
- 未决问题只能以**问题**形式提交（写入 open_question / questions）：禁止把仍未决的语义写成确定性的
  kill_line/falsifier/expect，更禁止把某个读法单方面定性为「正确/科学上唯一安全」
- 必填字段：hidden_contracts[].{id,statement,kind,locus,discovered_via,evidence,violates_if,patcher_action,confidence,open_question}
  与 structure_map[].{entry,chain,termination}
- ★ probes 是**可选**辅助证据 ★：只有当某条隐藏契约需要变成「可复核命令」时才写探针（用 probe_ids 关联契约），
  并用探针字段记录验证结果：probe.confidence（0–1）、probe.open_question（仍未决的语义，确定时写 "无"）；
  可选字段（不参与 schema 校验，但会被下游读取作参考证据）：probe.priority（P0–P3）、probe.contract、
  probe.hard_constraint、probe.contract_face、probe.observable_dims、probe.expected_values、probe.baseline、
  probe.failure_attribution、probe.reachability、probe.rank、probe.kill_line、probe.falsifier、probe.alt_sites，
  以及 probe.dimension（main_path|param_space|name_variants|robustness|api_surface）与顶层 coverage_matrix。
  **不要**为了凑探针数量而写探针：契约已经能用 file:line / 文档原文 / 实测输出说清楚时，probes 可以是空数组。
- 每个探针（若产出）必须附 patcher_guidance（1-3 句）：说明出题意图，以及 patcher 修代码时要注意的点
  （该探针保护哪条不变量、哪些地方禁止改动、哪些关联入口需一并覆盖）。该字段会被原样注入 patcher 提示词，
  注入处会明确标注「prober 的一家之言，可能出错，需独立核实」——请给出**可被核实**的理由（指向代码/公开材料/复现），
  而不是要求 patcher 盲从结论
- 报告 notes 中必须含 HYPOTHESES 决策块：每行 = rank | site(file:line) | reach(入口→…→site) | claim(错误行为一句话) |
  kill_line(单行命令) | baseline verdict(stands|refuted) | confidence(0–1)。最多 5 条，rank 1 只能有一条（并列除外）；
  没有 kill line 的假设不得排名。该块是给 patcher 的**导航地图**，不是它必须服从的判决：patcher 有权用自己的实测
  推翻其中任意一条，并会在最终回复里记录差异
- 探索预算（Probe Skill §39）：目标 ≤40 次工具调用、硬上限 60；一旦 rank1 假设有了"已跑过"的 kill line +
  本底结论 + 一个排第二的备选，立刻停止探索并交报告
- 输出纪律：只允许 digest（scalar / shape / dtype / 首个差异元素 / 首行 traceback，≤20 行），
  禁止打印整段数组或整份 catalogue（存文件 + 打印路径与摘要）
- 即使分析不完整，也必须把当前已有发现交成一份报告（未完成的项在 notes 中注明），绝不允许空手交卷
- ★ 交付自检（交卷前逐条确认）★：hidden_contracts ≥ 3、kinds ≥ 2、structure_map ≥ 2、每条契约 evidence 可复核、
  每条契约有 violates_if、每条契约有 confidence/open_question。
`;

const EXPERT_ROLES: { role: string; brief: string }[] = [
  {
    role: 'tester',
    brief: `你是"SciProber"（隐藏契约勘查员，负责**识别隐藏契约**并画出**仓库结构图**：重建开发者的修复目标，指出那些没写在签名/文档里、却被多处调用点共同依赖的行为约定）。
★ 你的第一交付物是 hidden_contracts（隐藏契约清单）+ structure_map（入口 → 调用链 → 契约站点 → 兄弟调用点）。探针只是把某条契约变成可复核命令的**可选辅助证据**。★
★ 你的输出是假设与线索，不是判决：你不是预言机，你产出的契约/结构图/探针都不是私有测试、不构成验收门禁；探针全绿不代表修复正确，探针失败也不代表修复错误。最终裁决权属于 patcher 的实测与 public 测试。★
开始前必须遵守下方嵌入的「Probe Skill 标准」（隐藏契约勘查 Hidden-Contract Reconnaissance）：交付顺序固定为 hidden_contracts → structure_map → 探针（可选），缺前者不要写后者。
第一步：读 bug 现场 + 代码，定位候选站点；先做 §4.1 MANDATORY FIRST GATE 的 **sibling-call sweep**（用 repo-graph / grep 找出共享同一契约、必须一并评估的兄弟调用点）。
第二步：**structure_map**——把「公开入口 → 逐跳调用 → 契约生效/被违反的站点 → 兄弟调用点」画成 CallChain（≥2 条入口链），每条链写清四问：这条路径怎么走到契约站点？站点在该路径上的输入是什么？兄弟调用点里谁会受影响？谁的期望会变（§4.2）。
第三步：用发现手法 A–H（§3，A=调用点并置最有效、B=数据结构自洽、C=两路径必须同结果、D=异常边界、E=单位与 axis、F=公开材料对照、G=对称性与守恒律、H=依赖语义）逐条找出**隐藏契约**，每条给出 statement / kind（CONTRACT_KINDS 10 种之一）/ locus / discovered_via / evidence（可复核 file:line 或实测输出）/ scope / violates_if / confidence / open_question / patcher_action。最低配额：contracts ≥ 3、kinds ≥ 2、chains ≥ 2（CONTRACT_QUOTAS）；宁少勿滥，泛泛而谈不算契约（§1.1）。
第四步：**可选探针**（§7）——只有当某条契约需要变成可复核命令时才写（每个契约最多一个，probe_ids 关联回去），必须记录本底实测；同一证据的重复探针合并。**不要为凑数量写探针；探针全绿/全红都不改变验收。**
第五步（★ 决策层，Probe Skill §8 ★）：输出 HYPOTHESES 决策块（rank | site(file:line) | reach | claim | kill_line | baseline verdict | confidence），并把同名字段（probe.rank / probe.kill_line / probe.falsifier / probe.alt_sites / probe.confidence）镜像到对应探针上。每个排上名的假设必须带一条 ≤1 轮可跑完的 kill line，且已在未修复代码上实跑、原文记录本底结论（stands/refuted）。最多 5 条，允许并列（rank: 1=）。
★ 你是假设生成者而不是仲裁者 ★：契约条目、排名与 kill line 都是给 patcher 的**讨论输入与导航建议**，不是它必须服从的判决，也不是验收清单。patcher 会自行实测裁决，并有权推翻你任意一条结论；kill line 没翻转 ≠ 修复失败。因此：每条契约与每条假设必须给出真实的自评 confidence（低置信度是常态，虚高是错误）；仍未决的语义只能写入 open_question / questions 以**问题**形式提出，禁止伪装成确定性结论（例如禁止断言「只有 (a) 这个读法是正确的，另一种在科学上不安全」）。
关键原则：契约与探针必须独立于 public 复现脚本、必须 candidate-independent（生成时禁止查看/针对候选 patch）。
交付自检（§10.3）：hidden_contracts ≥ 3 条、≥ 2 种 kind、structure_map ≥ 2 条入口链、每条契约 evidence 可复核且 violates_if 非空；未决语义一律以 open_question 提出。
你必须自己设计独特测试：禁止阅读或照搬历史 run（如 .codex-sci-debug/runs/ 下）遗留的探针/测试文件。`
  },
  {
    role: 'domain-invariant',
    brief: `你是"SciPatcher"（科学补丁专家，领域不变量背景），专精生化/量子化学计算代码。你的任务：找出这个 bug 可能破坏的物理/数值不变量，把它们写成**隐藏契约条目**（不是验收门禁：契约与探针都是可错的一家之言，探针全绿不代表修复正确）。
检查面：物理单位一致性、守恒量（能量/电荷/原子数）、数组契约（shape/ordering/索引语义）、周期性边界条件、数值稳定性（除零、溢出、收敛阈值）。
第一交付物是 hidden_contracts + structure_map：每条契约给 locus(file:symbol)、evidence(file:line/文档原文/实测输出)、violates_if、confidence、open_question、patcher_action；结构图要画出入口 → 调用链 → 契约站点 → 兄弟调用点。探针只在需要可复核命令时才产出。`
  },
  {
    role: 'kimi',
    brief: `你是第二个独立的 "SciProber"（kimi-k3 通道，与 tester 通道并行、彼此独立）。任务与第一通道完全相同：识别隐藏契约、画出仓库结构图，指出没写在签名/文档里却被多处调用点共同依赖的行为约定（不是私有测试、不构成验收门禁）。
★ 你的第一交付物是 hidden_contracts（≥3 条、≥2 种 kind）+ structure_map（≥2 条入口链）；探针只是可选辅助证据。★
★ 你不是预言机：契约/探针都是假设与线索，探针全绿不代表修复正确，探针失败也不代表修复错误；最终裁决权属于 patcher 的实测与 public 测试。★
开始前必须遵守下方嵌入的「Probe Skill 标准」（隐藏契约勘查）：先做 sibling-call sweep，再用手法 A–H 找隐藏契约（≥3 条 / ≥2 kind）并画 structure_map（≥2 条链），探针可选。
关键原则：契约与探针必须独立于 public 复现脚本与另一探针通道，且 candidate-independent（生成时禁止查看/针对候选 patch）。每条契约与每条探针必须给出 confidence 与 open_question；仍未决的语义只能以问题形式提出，禁止伪装成确定性结论。
你必须自己设计独特测试：禁止阅读或照搬历史 run（如 .codex-sci-debug/runs/ 下）遗留的探针/测试文件。`
  }
];

export function expertRoles(): string[] {
  return EXPERT_ROLES.map((e) => e.role);
}

function buildExpertPrompt(
  role: string,
  brief: string,
  intake: string,
  knowledge?: string,
  knowledgeDir?: string,
  timeLimitMs?: number,
  probeSkill?: string
): string {
  const probeSkillSection =
    probeSkill?.trim()
      ? `\n=== SciProber Skill（probe_skill.md：隐藏契约勘查标准，第一交付物是 hidden_contracts + structure_map；探针只是可选第三交付物）===
${probeSkill.trim()}

`
      : '';
  const knowledgeSection = [
    knowledge?.trim()
      ? `=== 领域知识清单（${role}） ===\n以下是与当前角色相关的领域事实/不变量清单，仅作约束参考，请以代码为准：\n${knowledge.trim()}\n`
      : '',
    knowledgeDir?.trim()
      ? `开始前请先阅读 ${knowledgeDir.trim()} 目录下的领域知识文档（只读），只取与当前 bug class 相关的部分作为参考。`
      : ''
  ]
    .filter(Boolean)
    .join('\n');
  const middle = knowledgeSection ? `${knowledgeSection}\n\n` : '';
  const timeLimitSection = timeLimitMs
    ? `\n=== 时间限制（硬约束）===
- 本任务总时限约 ${Math.round(timeLimitMs / 60000)} 分钟，必须在时间耗尽前输出符合上述 schema 的 JSON 报告。
- 最后 5 分钟必须开始写 JSON 报告：允许部分项目不完整（在 notes 中注明未完成项），但 JSON 必须完整且可解析。
- 绝不允许空手交卷：即使分析未完成，也要把当前已有发现交成报告，不要等到超时什么都没有。
`
    : '';
  return `${brief}

${probeSkillSection}${middle}${REPORT_SCHEMA_HINT}
${timeLimitSection}

${ACCEPTANCE_SCOPE_CLAUSE}

${CONTRACT_COMPLETENESS_CLAUSE}

${HIDDEN_CONTRACT_QUOTA_CLAUSE}

${PROBE_AS_EVIDENCE_CLAUSE}

=== Bug 现场（intake） ===
${intake}
`;
}

/** 从 claude 会话 jsonl 恢复最终文本（最后一个含 text 的 assistant 消息），再走 extractJson。 */
function recoverFromJsonl(jsonlPath: string): unknown {
  try {
    const lines = fs.readFileSync(jsonlPath, 'utf8').split('\n').filter(Boolean);
    let lastText: string | undefined;
    for (const line of lines) {
      let d: { message?: { content?: Array<{ type?: string; text?: string }> } };
      try { d = JSON.parse(line); } catch { continue; }
      const c = d.message?.content;
      if (Array.isArray(c)) {
        for (const b of c) {
          if (b && b.type === 'text' && typeof b.text === 'string' && b.text) lastText = b.text;
        }
      }
    }
    if (!lastText) return undefined;
    return extractJson(lastText);
  } catch {
    return undefined;
  }
}

/** 并行运行全部专家；单个失败不阻塞其他。 */
export async function runExperts(
  intake: string,
  options: CodexRunOptions,
  modelOverrides?: Record<string, string>,
  keyOverrides?: Record<string, string>,
  providerOverrides?: Record<string, ModelProviderConfig>,
  knowledgeOverrides?: Record<string, string>,
  knowledgeDir?: string,
  onProgress?: (role: string, status: 'started' | 'done' | 'failed' | 'recovered-from-jsonl') => void,
  expertRoles?: string[],
  probeSkill?: string,
  /**
   * ★ 本底判别诊断（确定性，非 LLM；只标注信息量，不判分、不剔除）★：在**未修复的工作区**上真跑一遍该角色的探针。
   * 返回 executed=false 表示诊断自身没跑起来（环境问题），此时不做判定、不阻塞出题。
   */
  probeBaseline?: (role: string, probes: Probe[]) => Promise<ProbeBaselineGate>
): Promise<ExpertResult[]> {
  const expertOptions: CodexRunOptions = { ...options, sandbox: 'danger-full-access' };
  const active = expertRoles
    ? EXPERT_ROLES.filter((e) => expertRoles.includes(e.role))
    : EXPERT_ROLES;

  const runOne = async (expert: { role: string; brief: string }): Promise<ExpertResult> => {
    onProgress?.(expert.role, 'started');
    const prompt = buildExpertPrompt(
      expert.role,
      expert.brief,
      intake,
      knowledgeOverrides?.[expert.role],
      knowledgeDir,
      options.timeoutMs,
      probeSkill
    );
    const roleOptions: CodexRunOptions = {
      ...expertOptions,
      rawLogPath: options.rawLogDir ? path.join(options.rawLogDir, `${expert.role}.raw.txt`) : undefined,
      rawJsonlPath: options.rawJsonlDir ? path.join(options.rawJsonlDir, `${expert.role}.jsonl`) : undefined,
      model: modelOverrides?.[expert.role] || options.model,
      apiKey: keyOverrides?.[expert.role],
      provider: providerOverrides?.[expert.role] ?? options.provider,
      onActivity: options.onActivity
        ? (activity) => options.onActivity!(`[${expert.role}] ${activity}`)
        : undefined
    };
    let result = await runCodexOnce(prompt, roleOptions);
    let report = result.ok ? extractJson(result.text) : undefined;

    // stdout 解析/schema 失败时，从 claude 会话 jsonl（raw/<role>.jsonl）兜底恢复最终报告
    if (result.ok && !validateProbeReport(report) && options.rawJsonlDir) {
      const recovered = recoverFromJsonl(path.join(options.rawJsonlDir, `${expert.role}.jsonl`));
      if (recovered && validateProbeReport(recovered)) {
        report = recovered;
        onProgress?.(expert.role, 'recovered-from-jsonl');
      }
    }

    // schema 不合格则补正一次（resume 同一会话）
    if (result.ok && !validateProbeReport(report) && result.threadId) {
      result = await runCodexOnce(
        '你的输出不符合 schema。请只输出修正后的 JSON 对象，字段完整，不要输出其他内容。',
        { ...roleOptions, resumeThreadId: result.threadId }
      );
      report = result.ok ? extractJson(result.text) : undefined;
    }

    // ★ 隐藏契约交付确定性检查（非 LLM；★ 非阻塞 ★）：未达标 → 补正一次；仍缺 → 放行并记录告警
    let coverageMissing: string[] | undefined;
    let contractCov: ContractCoverage | undefined;
    if (result.ok && validateProbeReport(report)) {
      const coverage = contractCoverage(report);
      contractCov = coverage;
      coverageMissing = coverage.legacy ? [] : coverage.missing;
      if (coverageMissing.length > 0 && result.threadId) {
        result = await runCodexOnce(
          `你的报告隐藏契约交付未达标，缺失项：${coverageMissing.join('、')}。` +
          `请补齐：hidden_contracts 至少 ${CONTRACT_QUOTAS.minContracts} 条、至少 ${CONTRACT_QUOTAS.minKinds} 种不同 kind、` +
          `structure_map 至少 ${CONTRACT_QUOTAS.minChains} 条入口链；每条契约必须含 ` +
          `statement / kind / locus / discovered_via / evidence(可复核) / violates_if / confidence / open_question / patcher_action。` +
          '只输出修正后的完整 JSON 对象，不要输出其他内容。',
          { ...roleOptions, resumeThreadId: result.threadId }
        );
        const rerun = result.ok ? extractJson(result.text) : undefined;
        if (rerun && validateProbeReport(rerun)) {
          report = rerun;
          const c2 = contractCoverage(rerun);
          contractCov = c2;
          coverageMissing = c2.legacy ? [] : c2.missing;
        }
      }
    }

    // ★ 本底诊断（★ 不是门禁：结果不剔除探针、不阻断交付、不影响验收 ★）★
    // 探针在「未修复本底」上被真跑一遍，只为给出诊断证据：本底通过 = 假绿（对本次修复零判别力）；
    // 跑不起来 = 坏探针。二者只回灌给你自己参考（是否修订探针由你判断），验收永远只由 public 测试决定。
    let baselineGate: ProbeBaselineGate | undefined;
    if (result.ok && validateProbeReport(report) && probeBaseline) {
      try {
        baselineGate = await probeBaseline(expert.role, report.probes);
      } catch (err) {
        baselineGate = undefined;
      }
      const lowSignalProbes = baselineGate?.low_signal_probes ?? [];
      if (baselineGate?.executed && lowSignalProbes.length > 0 && result.threadId) {
        // ★ 这里不是门禁：只是把本底实测证据递给你。修不修由你自己判断（也可以原样交卷）。★
        result = await runCodexOnce(
          `${baselineGate.feedback}\n\n` +
            '以上只是**诊断信息**（不影响验收，也不会剔除任何探针）：若你认为这些探针确实无判别力或写错了，' +
            '可以修订它们；若你认为它们仍然成立，直接原样交卷即可。' +
            '若要修订，修订后的回复仍是**完整 JSON 对象**（字段齐全：hidden_contracts 与 structure_map 必须给出，' +
            '每条 hidden_contract 含 kind/evidence/confidence/open_question，每条 structure_map 链路含调用点并置证据；' +
            'probes 可以是**空数组**——探针只是可选第三交付物，dimension 是 legacy 可选字段），' +
            '只输出该 JSON，不要输出任何解释。',
          { ...roleOptions, resumeThreadId: result.threadId }
        );
        const rerun = result.ok ? extractJson(result.text) : undefined;
        if (rerun && validateProbeReport(rerun)) {
          report = rerun;
          const c3 = contractCoverage(rerun);
          contractCov = c3;
          coverageMissing = c3.legacy ? [] : c3.missing;
          // 复测：验证修订是否真的消除了假绿/坏探针（第二轮实测证据）
          try {
            const recheck = await probeBaseline(expert.role, rerun.probes);
            if (recheck.results.length > 0) baselineGate = recheck;
          } catch (err) {
            /* 复测失败保留首轮证据 */
          }
        }
      }
    }

    if (result.ok && validateProbeReport(report)) {
      onProgress?.(expert.role, 'done');
      return {
        role: expert.role,
        ok: true,
        report,
        coverage_missing: coverageMissing?.length ? coverageMissing : undefined,
        contract_coverage: contractCov,
        baseline_gate: baselineGate
      };
    }
    onProgress?.(expert.role, 'failed');
    return { role: expert.role, ok: false, error: result.error ?? 'invalid probe report schema' };
  };

  return Promise.all(active.map(runOne));
}
