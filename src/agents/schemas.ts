import * as fs from 'fs';
import * as path from 'path';

export interface Probe {
  id: string;
  title: string;
  kind: 'python' | 'shell';
  code: string;
  expect: string;
  /** 探针所属输入维度（PROBE_DIMENSIONS 之一，legacy），用于覆盖审计。 */
  dimension?: string;
  /** 出题人指引（给 patcher）：出题意图 + 修代码时需注意的点（保护的不变量、禁止事项、需连带覆盖的入口）。 */
  patcher_guidance?: string;
  /** 优先级 P0–P3（prober 声明）。P0/P1 = 信息量较低时会被标注 low_signal 的对象（诊断，不是门禁）。 */
  priority?: string;
  /** 目标契约要求原文/编号（prober 声明，对应 probe_skill §1 隐藏契约）。 */
  contract?: string;
  /** true = 违反即科学不安全（一票否决），与 P0/P1 同等强制。 */
  hard_constraint?: boolean;
  /** 目标契约面（probe_skill §1 隐藏契约）：本探针钉住的是哪一条对外可观测契约。 */
  contract_face?: string;
  /** 可观测输出维度（probe_skill §3 发现手法）：本探针读的是哪个可观测输出量（返回值/副作用/异常/日志）。 */
  observable_dims?: string;
  /** 期望值的独立出处（probe_skill §6.1 证据强度）：期望值凭什么成立（契约原文/守恒律/公开文档）。 */
  expected_values?: string;
  /** 未修复本底上的实测行为（probe_skill §7.3 本底协议）。 */
  baseline?: string;
  /** 本底失败归因（probe_skill §7.3 本底协议 / §7.4 digest）：本底失败必须由探针自己的断言触发——记录该断言的 file:line、异常文本、实测 vs 期望值；若控制流在到达该断言前就被前置校验/无关异常/导入失败/超时截断，则本探针没有证明任何东西（invalid）。 */
  failure_attribution?: string;
  /** 可达性论证（probe_skill §6.1 证据强度）：本探针断言的目标行为确实可达，不存在前置不满足。 */
  reachability?: string;
  /** 未决语义（probe_skill §6.2 置信度纪律）：本探针设计时仍不确定、必须以**问题**形式提出、不得当作已决结论的部分（必填）。 */
  open_question?: string;
  /** ★ prober 自评的假设置信度 0–1（低置信度是常态）：探针是线索不是结论，patcher 必须自行实测裁决。 */
  confidence?: number | string;
  /** 假设排名（probe_skill §8）：1 = prober 建议 patcher 首先查看的站点；`1=` 表示并列。排名只是导航建议，不是验收顺序，也不代表结论。 */
  rank?: number | string;
  /** 反证命令（probe_skill §8 kill-line）：≤1 轮可跑完的单行命令，其 refutes_if 结果可判本假设为假；会被原样注入 patcher 提示词作为线索。 */
  kill_line?: string;
  /** refutes_if 的具体结果 + 未修复本底上的实测原文（probe_skill §8 kill-line）。★ 仅供参考：kill line 未翻转只说明该假设可能不成立，不构成修复失败。 */
  falsifier?: string;
  /** 备选站点（probe_skill §8 kill-line）：必须是可执行的 kill-line 命令，禁止只写裸符号名。 */
  alt_sites?: string;
}


/** 探针在「未修复本底」上的判别分类。 */
export type BaselineClassification =
  | 'discriminating' // 本底上失败 = 有判别力（符合预期）
  | 'non_discriminating' // 本底上通过 = 假绿，对本次修复无判别力
  | 'broken'; // 探针自身跑不起来（语法/导入/超时），既不是失败也不是通过

export interface ProbeBaselineResult {
  probe_id: string;
  title: string;
  /** 归一化后的优先级：P0–P3，或 'unknown'。 */
  priority: string;
  hard_constraint: boolean;
  /** priority 为 P0/P1 或 hard_constraint=true → 该探针的本底结果会被标注为诊断信号（不剔除、不阻断）。 */
  blocking: boolean;
  exit_code: number;
  classification: BaselineClassification;
  /**
   * 本底失败归因（probe_skill §7.3 本底协议）：
   * self = 最深 traceback 帧在探针文件内（失败确由本探针自己的断言触发）；
   * external = 最深帧在被测代码/site-packages 内（前置校验、无关异常、导入失败——
   *            探针并未到达自身断言，不能据此主张判别力）；
   * unknown = 无 Python traceback 帧可解析（非 Python 运行器、超时等），归因不明。
   * 仅作证据与反射提示，不单独用于剔除探针（避免启发式误杀）。
   */
  attribution?: 'self' | 'external' | 'unknown';
  /** 最深 traceback 帧 `file:line`（解析到才有）。 */
  attributed_frame?: string;
  output_tail: string;
}

/**
 * 本底判别诊断结果（确定性，非 LLM）。
 *
 * ★ 语义（去预言机化）★：探针是**证据**，不是验收门禁。
 *   - 本结构只回答一个诊断问题：「这套探针在未修复本底上有没有信号？」
 *   - `ok` **不参与任何验收判定**，也不影响 run 的成败；verifier 的 ok 只由 public 命令决定。
 *   - 本底即通过（假绿）或跑不起来的探针**不会被剔除**，仍会物化并作为低信息量线索提供给 patcher。
 */
export interface ProbeBaselineGate {
  /** 仅表示「套件本底上具备判别力」这一诊断信号；**不作为验收依据，不影响 run 成败**。 */
  ok: boolean;
  /** false = 探针根本没跑起来（环境/解释器问题），此时不做诊断。 */
  executed: boolean;
  reason: string;
  results: ProbeBaselineResult[];
  /** 诊断用：本底即通过（假绿）或跑不起来的 P0/P1 探针 id —— 低信息量证据，**不剔除、不阻断**。 */
  blocking_probes: string[];
  /** @deprecated 恒为空数组：探针不再从验证集合中剔除（探针不是门禁）。 */
  excluded_probes: string[];
  /** 低信息量探针 id（本底即通过 = 修复前后行为相同，或探针自身跑不起来）：仅提示该证据参考价值低。 */
  low_signal_probes?: string[];
  /** 本底上确实失败的探针 id（有判别力的证据）。 */
  discriminating: string[];
  summary: string;
  /** 回灌给 prober 参考轮的证据文本（建议性质，非强制重写）。 */
  feedback: string;
}

export interface ExposurePath {
  file: string;
  symbol: string;
  how: string;
}

/** ★ prober 的核心交付物：隐藏契约 ★ */
export interface HiddenContract {
  /** 契约编号，如 "HC1"。 */
  id: string;
  /** 一句话陈述这条隐藏契约（必须是**可复核/可证伪**的行为断言，不是泛泛而谈）。 */
  statement: string;
  /** 契约种类（CONTRACT_KINDS 之一）。 */
  kind: string;
  /** 契约在被测代码中生效/被依赖的位置，写成 `file:symbol`（可带 `:line`）。 */
  locus: string;
  /** 谁在守护它：承载该约定的代码/数据结构/文档/公开材料（可空）。 */
  enforced_by?: string;
  /** 你是怎么发现它的：调用点并置 / 数据结构自洽 / 两条路径必须同结果 / 异常边界 / 单位与 axis 约定 / 公开材料与实现对照（必填，证据链的起点）。 */
  discovered_via: string;
  /** 可核证据：`file:line` 引用、文档原文、或你自己跑出来的实测输出。禁止「我认为」。 */
  evidence: string;
  /** 适用范围：哪些入口 / 参数 / 运行模式受这条契约约束。 */
  scope?: string;
  /** 什么样的修复会破坏它（反例风险）——这是给 patcher 的最有价值信息。 */
  violates_if: string;
  /** 自评置信度 0–1（低置信度是常态，虚高是错误）。 */
  confidence?: number | string;
  /** 仍未决、只能以**问题**形式提出的语义（确定时写 "无"）。 */
  open_question?: string;
  /** 要求 patcher 独立核实/必须保留的具体事项（1-3 句）。 */
  patcher_action: string;
  /** 可选：把这条契约变成可复核命令的探针 id 列表（对应 report.probes[].id）。 */
  probe_ids?: string[];
}

/** ★ prober 的仓库结构分析：入口 → 逐跳调用链 → 契约站点 → 兄弟调用点 ★ */
export interface CallChain {
  /** 公开入口，写成 `file:symbol`。 */
  entry: string;
  /** 逐跳调用 `file:symbol` → … → 契约生效/被违反的站点。 */
  chain: string;
  /** 这条链的终点说明了什么（契约在哪一步被依赖/破坏）。 */
  termination: string;
  /** 共享同一契约、必须一并评估的兄弟调用点（`file:symbol`，可空）。 */
  siblings?: string[];
  /** 备注（可选）。 */
  note?: string;
}

export interface ProbeReport {
  role: string;
  questions: string[];
  exposure_paths: ExposurePath[];
  /** ★ 核心交付物：识别出的隐藏契约清单（旧版报告可能缺失 → legacy）。 */
  hidden_contracts?: HiddenContract[];
  /** ★ 仓库结构图：入口 → 调用链 → 契约站点 → 兄弟调用点。 */
  structure_map?: CallChain[];
  /** 辅助证据（可空）：只有当某条隐藏契约需要变成可复核命令时才产出。探针不是验收门禁。 */
  probes: Probe[];
  notes?: string;
  /** 维度 → 探针 id 列表；必须与 probes[].dimension 一致，且每个维度满足最低配额。 */
  coverage_matrix?: Record<string, string[]>;
}

/** 隐藏契约的种类（任务无关的通用分类）。 */
export const CONTRACT_KINDS = [
  'invariant',
  'precondition',
  'postcondition',
  'unit_convention',
  'ordering',
  'error_semantics',
  'naming_alias',
  'data_shape',
  'numerical_tolerance',
  'resource_lifecycle'
] as const;
export type ContractKind = (typeof CONTRACT_KINDS)[number];

/** 隐藏契约的最低交付要求（非阻塞：未满足 → 补正一次，仍缺则告警放行）。 */
export const CONTRACT_QUOTAS = {
  /** 至少识别出的隐藏契约条数。 */
  minContracts: 3,
  /** 至少覆盖的不同契约种类数。 */
  minKinds: 2,
  /** structure_map 至少要覆盖多少条暴露入口。 */
  minChains: 2
} as const;

export interface ContractCoverage {
  /** 无 hidden_contracts 元数据（旧版报告），跳过缺失告警。 */
  legacy: boolean;
  count: number;
  /** kind → 条数。 */
  counts: Record<string, number>;
  hasStructureMap: boolean;
  /** 未满足的最低要求项（如 `hidden_contracts≥3`、`kinds≥2`、`structure_map≥2`）。 */
  missing: string[];
}

/** 探针维度（legacy，2026-09-16 起不再作为交付门禁）。 */
export const PROBE_DIMENSIONS = ['main_path', 'param_space', 'name_variants', 'robustness', 'api_surface'] as const;
export type ProbeDimension = (typeof PROBE_DIMENSIONS)[number];

/** 每个维度的最低探针数配额（legacy：仅供参考，不再阻塞交卷；现行硬配额见 CONTRACT_QUOTAS）。 */
export const PROBE_QUOTAS: Record<ProbeDimension, number> = {
  main_path: 2,
  param_space: 1,
  name_variants: 1,
  robustness: 1,
  api_surface: 1
};

export function isValidHiddenContract(value: unknown): value is HiddenContract {
  const c = value as HiddenContract;
  return (
    !!c &&
    typeof c === 'object' &&
    typeof c.id === 'string' &&
    typeof c.statement === 'string' &&
    c.statement.trim().length > 0 &&
    typeof c.kind === 'string' &&
    typeof c.locus === 'string' &&
    typeof c.discovered_via === 'string' &&
    typeof c.evidence === 'string' &&
    typeof c.violates_if === 'string' &&
    typeof c.patcher_action === 'string'
  );
}

export function isValidCallChain(value: unknown): value is CallChain {
  const c = value as CallChain;
  return (
    !!c &&
    typeof c === 'object' &&
    typeof c.entry === 'string' &&
    typeof c.chain === 'string' &&
    typeof c.termination === 'string' &&
    (c.siblings === undefined || (Array.isArray(c.siblings) && c.siblings.every((x) => typeof x === 'string')))
  );
}

/** 隐藏契约交付覆盖审计（确定性，非 LLM；非阻塞）。 */
export function contractCoverage(report: ProbeReport): ContractCoverage {
  const contracts = report.hidden_contracts ?? [];
  if (!Array.isArray(report.hidden_contracts)) {
    return { legacy: true, count: 0, counts: {}, hasStructureMap: false, missing: [] };
  }
  const counts: Record<string, number> = {};
  for (const c of contracts) {
    const k = (c && typeof c.kind === 'string' && c.kind) || 'unspecified';
    counts[k] = (counts[k] ?? 0) + 1;
  }
  const chains = Array.isArray(report.structure_map) ? report.structure_map : [];
  const missing: string[] = [];
  if (contracts.length < CONTRACT_QUOTAS.minContracts) {
    missing.push(`hidden_contracts≥${CONTRACT_QUOTAS.minContracts}`);
  }
  if (Object.keys(counts).filter((k) => k !== 'unspecified').length < CONTRACT_QUOTAS.minKinds) {
    missing.push(`contract_kinds≥${CONTRACT_QUOTAS.minKinds}`);
  }
  if (chains.length < CONTRACT_QUOTAS.minChains) {
    missing.push(`structure_map≥${CONTRACT_QUOTAS.minChains}`);
  }
  return { legacy: false, count: contracts.length, counts, hasStructureMap: chains.length > 0, missing };
}

/** 规范化报告：把可选集合补成全量，避免下游 undefined 展开。 */
export function normalizeReport(report: ProbeReport): ProbeReport {
  return {
    ...report,
    questions: Array.isArray(report.questions) ? report.questions : [],
    exposure_paths: Array.isArray(report.exposure_paths) ? report.exposure_paths : [],
    hidden_contracts: Array.isArray(report.hidden_contracts) ? report.hidden_contracts : [],
    structure_map: Array.isArray(report.structure_map) ? report.structure_map : [],
    probes: Array.isArray(report.probes) ? report.probes : []
  };
}

export interface ProbeCoverage {
  /** 该报告是否带有维度覆盖元数据（无则为旧版报告，跳过缺失告警）。 */
  legacy: boolean;
  counts: Record<string, number>;
  /** 配额未满足的维度列表（legacy 报告恒为空）。 */
  missing: string[];
}

/** 确定性覆盖检查：统计每个维度的探针数（coverage_matrix 与 probes[].dimension 取并集），
 *  返回配额未满足的维度。旧版报告（无维度元数据）标记 legacy=true 且不告警。 */
export function probeCoverage(report: ProbeReport): ProbeCoverage {
  const probes = report.probes ?? [];
  const byId = new Map<string, Probe>();
  for (const p of probes) byId.set(p.id, p);
  const hasMetadata =
    !!report.coverage_matrix || probes.some((p) => typeof p.dimension === 'string' && p.dimension.trim());
  const counts: Record<string, number> = {};
  for (const dim of PROBE_DIMENSIONS) counts[dim] = 0;
  if (hasMetadata) {
    const declared = new Map<string, Set<string>>();
    const declaredIds = (dim: string): Set<string> => {
      let set = declared.get(dim);
      if (!set) {
        set = new Set<string>();
        declared.set(dim, set);
      }
      return set;
    };
    if (report.coverage_matrix) {
      for (const [dim, ids] of Object.entries(report.coverage_matrix)) {
        if (Array.isArray(ids)) for (const id of ids) if (typeof id === 'string' && byId.has(id)) declaredIds(dim).add(id);
      }
    }
    for (const p of probes) {
      const dim = typeof p.dimension === 'string' ? p.dimension.trim() : '';
      if (dim && PROBE_DIMENSIONS.includes(dim as ProbeDimension)) declaredIds(dim).add(p.id);
    }
    for (const dim of PROBE_DIMENSIONS) counts[dim] = declared.get(dim)?.size ?? 0;
  }
  const missing = hasMetadata
    ? PROBE_DIMENSIONS.filter((dim) => counts[dim] < PROBE_QUOTAS[dim])
    : [];
  return { legacy: !hasMetadata, counts, missing };
}

export interface ProbeTestResult {
  probe_id: string;
  title: string;
  /**
   * ★ 仅表示「这条证据探针自己的断言成立」（退出码 0）★——**不是**验收通过，
   * 不构成任何门禁，也**不参与**候选补丁选择（去预言机化 2026-09-16）。
   */
  passed: boolean;
  output: string;
}

export interface VerifyResult {
  ok: boolean;
  probe_results: ProbeTestResult[];
  public_ok?: boolean;
  public_output?: string;
  summary: string;
}

export type PipelineStage =
  | 'intake'
  | 'probe'
  | 'probe-done'
  | 'repair'
  | 'patcher-done'
  | 'verify'
  | 'mentor'
  | 'done'
  | 'failed';

export interface RunState {
  runId: string;
  stage: PipelineStage;
  retries: number;
  failedExperts: string[];
  patchSummary?: string;
  verifySummary?: string;
}

export function isValidProbe(value: unknown): value is Probe {
  const probe = value as Probe;
  return (
    !!probe &&
    typeof probe.id === 'string' &&
    typeof probe.title === 'string' &&
    (probe.kind === 'python' || probe.kind === 'shell') &&
    typeof probe.code === 'string' &&
    typeof probe.expect === 'string' &&
    (probe.dimension === undefined || typeof probe.dimension === 'string')
  );
}

export function validateProbeReport(value: unknown): value is ProbeReport {
  const report = value as ProbeReport;
  return (
    !!report &&
    typeof report.role === 'string' &&
    Array.isArray(report.questions) &&
    report.questions.every((q) => typeof q === 'string') &&
    Array.isArray(report.exposure_paths) &&
    report.exposure_paths.every(
      (p) => p && typeof p.file === 'string' && typeof p.symbol === 'string' && typeof p.how === 'string'
    ) &&
    (Array.isArray(report.probes) || Array.isArray(report.hidden_contracts)) &&
    (!Array.isArray(report.probes) || report.probes.every(isValidProbe)) &&
    (report.hidden_contracts === undefined ||
      (Array.isArray(report.hidden_contracts) && report.hidden_contracts.every(isValidHiddenContract))) &&
    (report.structure_map === undefined ||
      (Array.isArray(report.structure_map) && report.structure_map.every(isValidCallChain))) &&
    (report.coverage_matrix === undefined ||
      (typeof report.coverage_matrix === 'object' &&
        report.coverage_matrix !== null &&
        !Array.isArray(report.coverage_matrix) &&
        Object.values(report.coverage_matrix).every(
          (ids) => Array.isArray(ids) && ids.every((x) => typeof x === 'string')
        )))
  );
}

/** 从模型输出文本中提取 JSON（容忍 markdown 围栏与前后杂文本）。 */
export function extractJson(text: string): unknown | undefined {
  const fenced = text.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
  const candidates = fenced ? [fenced[1], text] : [text];
  for (const candidate of candidates) {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        // try next candidate
      }
    }
  }
  return undefined;
}

export function writeArtifact(runDir: string, name: string, data: unknown): string {
  const file = path.join(runDir, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof data === 'string' ? data : JSON.stringify(data, null, 2));
  return file;
}
