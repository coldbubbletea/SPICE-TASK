import fs from 'fs';
import path from 'path';
import { CodexRunOptions, ModelProviderConfig, runCodexOnce } from '../agents/runner';
import { VerifyResult, extractJson } from '../agents/schemas';
import { ACCEPTANCE_SCOPE_CLAUSE, CONTRACT_COMPLETENESS_CLAUSE, MENTOR_RUBRIC_CLAUSE } from './promptClauses';

export type MentorChoice = 'sci' | 'general' | 'ds' | 'synthesized' | 'candidate_1' | 'candidate_2' | 'candidate_3';

/** 匿名化映射：candidate_1 = sci，candidate_2 = general，candidate_3 = ds；prompt 只展示匿名标签，代码侧负责还原。 */
const CANDIDATE_TO_SOURCE: Record<string, 'sci' | 'general' | 'ds'> = {
  candidate_1: 'sci',
  candidate_2: 'general',
  candidate_3: 'ds'
};

/** 六维 rubric 分数（每维 0-10）。 */
export interface MentorDimensionScores {
  functional: number;
  numerical: number;
  scientific: number;
  robustness: number;
  intent: number;
  quality: number;
}

/** 单个候选的 rubric 评价。 */
export interface MentorCandidateEval {
  /** 匿名标签：candidate_1 | candidate_2 | synthesized */
  candidate: string;
  scores: MentorDimensionScores;
  /** Critical Scientific Error：是否违反关键科学不变量（硬约束过滤项）。 */
  cse: boolean;
  violated_invariant?: string;
  rationale?: string;
}

/** SciReviewer 终审裁决：按 rubric 在三个候选补丁中择优、合成，或打回再生成。 */
export interface MentorVerdict {
  verdict: 'accept' | 'regenerate';
  /** verdict=accept 时必填：CSE 过滤 + 加权 argmax 胜者（candidate_1/candidate_2/candidate_3）；regenerate 时可为 'regenerate'。 */
  choice: MentorChoice | 'regenerate';
  /** verdict=accept 时必填：胜者补丁经 SciReviewer 修补打磨后的完整 unified diff（git diff 格式，可 git apply）。 */
  patch?: string;
  /** verdict=accept 且 patch 省略/过长时：打磨后 diff 写入评审会话当前目录的文件（如 polished-patch.diff），系统读取并回填到 patch。 */
  patch_file?: string;
  semantic_issues: string[];
  guidance: string;
  /** 每个候选的 rubric 评价（六维分数 + CSE 硬约束 + 证据说明）。 */
  evaluation?: MentorCandidateEval[];
  /** CSE 过滤后的候选排序（最优在前）。 */
  ranking?: string[];
}

/** Rubric 权重（Scientific Validity 权重最高，30%）。 */
export const MENTOR_RUBRIC_WEIGHTS: Record<keyof MentorDimensionScores, number> = {
  functional: 0.2,
  numerical: 0.2,
  scientific: 0.3,
  robustness: 0.15,
  intent: 0.1,
  quality: 0.05
};

/** 代码侧计算加权分（不信任 LLM 心算总分）。 */
export function mentorWeightedScore(scores: MentorDimensionScores): number {
  return (Object.keys(MENTOR_RUBRIC_WEIGHTS) as (keyof MentorDimensionScores)[])
    .reduce((sum, key) => sum + (Number.isFinite(scores[key]) ? scores[key] : 0) * MENTOR_RUBRIC_WEIGHTS[key], 0);
}

export interface MentorSelection {
  /** 最终选中补丁的来源；'regenerate' = 全部候选被 CSE 过滤（或无可用候选）。 */
  source: 'sci' | 'general' | 'ds' | 'synthesized' | 'regenerate';
  note: string;
  /** 被排除的候选说明（CSE / diff 不可用）。 */
  filteredOut: string[];
}

/**
 * Selection = 硬约束 + 加权分：
 * 1) CSE 硬约束过滤 P' = { P | CSE(P)=NO 且候选 diff 可用 }
 * 2) P* = argmax_{P∈P'} Score(P)（加权分由代码侧计算）
 * verdict 未带 evaluation（旧格式 / LLM 未输出）时回退到 LLM 声明的 choice。
 */
export function resolveMentorSelection(verdict: MentorVerdict, comparison: MentorComparison): MentorSelection {
  if (verdict.choice === 'synthesized') {
    return { source: 'synthesized', note: 'SciReviewer 合成三个候选生成更优补丁', filteredOut: [] };
  }
  const evals = Array.isArray(verdict.evaluation) ? verdict.evaluation : [];
  const entries = evals.filter((e) => e && CANDIDATE_TO_SOURCE[e.candidate]);
  if (entries.length > 0) {
    const surviving: MentorCandidateEval[] = [];
    const filteredOut: string[] = [];
    for (const e of entries) {
      const outcome =
        e.candidate === 'candidate_1' ? comparison.sci
          : e.candidate === 'candidate_2' ? comparison.general
            : comparison.ds;
      if (e.cse) {
        filteredOut.push(`${e.candidate} (CSE: ${e.violated_invariant || '违反关键科学不变量'})`);
      } else if (!outcome.available) {
        filteredOut.push(`${e.candidate} (diff 不可用)`);
      } else {
        surviving.push(e);
      }
    }
    if (surviving.length === 0) {
      return {
        source: 'regenerate',
        note: `rubric 硬约束：全部候选被过滤（${filteredOut.join('；') || '无可用候选'}）`,
        filteredOut
      };
    }
    let best = surviving[0];
    for (const e of surviving.slice(1)) {
      if (mentorWeightedScore(e.scores) > mentorWeightedScore(best.scores)) {
        best = e;
      }
    }
    const source = CANDIDATE_TO_SOURCE[best.candidate];
    return {
      source,
      note: `rubric 选择：${best.candidate}（→ ${source}），加权分 ${mentorWeightedScore(best.scores).toFixed(2)}；被过滤：${filteredOut.join('；') || '无'}`,
      filteredOut
    };
  }
  // 无 rubric 评价（旧格式 verdict / LLM 未输出 evaluation）：回退 LLM 声明的 choice（兼容匿名/旧标签）
  const choice = String(verdict.choice);
  if (choice === 'synthesized') {
    return { source: 'general', note: 'legacy synthesized 标签无候选可锚定，回退 general 候选', filteredOut: [] };
  }
  const fallback =
    choice === 'candidate_1' ? 'sci'
      : choice === 'candidate_2' ? 'general'
        : choice === 'candidate_3' ? 'ds'
          : choice === 'sci' ? 'sci'
            : choice === 'general' ? 'general'
              : choice === 'ds' ? 'ds'
                : undefined;
  if (!fallback) {
    return { source: 'regenerate', note: `choice 取值 ${String(verdict.choice)} 非法且无 rubric 评价可用`, filteredOut: [] };
  }
  return { source: fallback, note: `SciReviewer 接受 ${fallback} 补丁（无 rubric 评价，回退 LLM 声明 choice）`, filteredOut: [] };
}

/** 人类可读的 rubric 评价报告（每个候选一个打分区块），供落盘存档。 */
export function renderMentorEvaluationMarkdown(verdict: MentorVerdict): string {
  const lines: string[] = ['# SciReviewer rubric 评价报告', ''];
  for (const e of verdict.evaluation ?? []) {
    const source = CANDIDATE_TO_SOURCE[e.candidate];
    lines.push(`## ${e.candidate}${source ? `（${source}）` : ''}`);
    lines.push(`- Functional Correctness: ${e.scores.functional}/10`);
    lines.push(`- Numerical Correctness: ${e.scores.numerical}/10`);
    lines.push(`- Scientific Validity: ${e.scores.scientific}/10`);
    lines.push(`- Robustness: ${e.scores.robustness}/10`);
    lines.push(`- Intent Preservation: ${e.scores.intent}/10`);
    lines.push(`- Patch Quality: ${e.scores.quality}/10`);
    lines.push(`- Critical Scientific Error: ${e.cse ? 'YES' : 'NO'}`);
    if (e.violated_invariant) {
      lines.push(`- Violated Invariant: ${e.violated_invariant}`);
    }
    lines.push(`- Final Score: ${mentorWeightedScore(e.scores).toFixed(1)}/10`);
    lines.push(`- Decision: ${e.cse ? 'REJECT' : 'ACCEPT'}`);
    if (e.rationale) {
      lines.push(`- Rationale: ${e.rationale}`);
    }
    lines.push('');
  }
  if (verdict.ranking && verdict.ranking.length > 0) {
    lines.push('## Ranking（CSE 过滤后，最优在前）');
    verdict.ranking.forEach((c, i) => lines.push(`${i + 1}. ${c}`));
    lines.push('');
  }
  lines.push(`## 最终裁决：${verdict.verdict === 'accept' ? `ACCEPT（choice=${verdict.choice}）` : 'REGENERATE'}`);
  return lines.join('\n');
}

export interface MentorResult {
  ok: boolean;
  verdict?: MentorVerdict;
  error?: string;
}

export interface MentorRunOptions {
  codexPath: string;
  model: string;
  sandbox?: string;
  cwd: string;
  apiKey?: string;
  provider?: ModelProviderConfig;
  timeoutMs?: number;
  onActivity?: (activity: string) => void;
  /** 逐步评分进度文件（JSONL）：mentor 每评完一个维度立即追加一行，用户可 tail 实时看进度。 */
  progressFile?: string;
  /** 主工作区绝对路径（cwd 为评分 scratch 目录时，供 prompt 告知 mentor 可读的仓库位置）。 */
  workspaceRoot?: string;
  /** shot 样例内容（三层结构 expert shot）：提供时挂载进 mentor prompt，作为 rubric 校准锚点与 few-shot 参照。 */
  shotContent?: string;
  /** shot 参考件（完整 diff 等 reference artifacts）的绝对路径列表：注入 mentor prompt，供需要逐行比对时读取。 */
  shotReferenceFiles?: string[];
  /** reviewer skill 方法学标准内容：注入 SciReviewer 评审/修补打磨 prompt，作为打分纪律与 CSE 判据的方法学参照。 */
  reviewerSkillContent?: string;
  /** 前序逐维评分进度（JSONL 原文）：进入"修补打磨"兜底时注入 polish prompt，让 SciReviewer 看到自己已给出的打分依据。 */
  progressSummary?: string;
  /** 前序评审指导（上一轮给出的修复指令）：进入"修补打磨"兜底时注入 polish prompt。 */
  guidance?: string;
}

/** 逐步评分进度行（JSONL 单行）：每完成一个维度/CSE 判定追加一条。 */
export interface MentorProgressLine {
  candidate: string;
  dimension?: keyof MentorDimensionScores;
  score?: number;
  cse?: boolean;
  violated_invariant?: string;
}

/** 单个 patcher 的产物：补丁文本 + 其独立 verify 结果。 */
export interface MentorAgentOutcome {
  available: boolean;
  patch: string;
  verify: VerifyResult;
}

export interface MentorComparison {
  sci: MentorAgentOutcome;
  general: MentorAgentOutcome;
  ds: MentorAgentOutcome;
}

const MENTOR_CHOICE_VALUES: string[] = ['sci', 'general', 'ds', 'synthesized', 'candidate_1', 'candidate_2', 'candidate_3'];

function isDimensionScores(value: unknown): value is MentorDimensionScores {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const o = value as Record<string, unknown>;
  return (Object.keys(MENTOR_RUBRIC_WEIGHTS) as string[]).every(
    (key) => typeof o[key] === 'number' && Number.isFinite(o[key])
  );
}

function isCandidateEval(value: unknown): value is MentorCandidateEval {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const o = value as MentorCandidateEval;
  return typeof o.candidate === 'string' && isDimensionScores(o.scores) && typeof o.cse === 'boolean';
}

function validateMentorVerdict(value: unknown): value is MentorVerdict {
  const v = value as MentorVerdict;
  if (
    !v ||
    (v.verdict !== 'accept' && v.verdict !== 'regenerate') ||
    !Array.isArray(v.semantic_issues) ||
    !v.semantic_issues.every((s) => typeof s === 'string') ||
    typeof v.guidance !== 'string'
  ) {
    return false;
  }
  // 新方法：accept 必须给出所选候选的打磨后 patch（完整 diff）；旧格式 synthesized 标签兼容（有 patch 才放行）
  const hasPolishPatch = typeof v.patch === 'string' && v.patch.trim().startsWith('diff') && v.patch.trim().length > 40;
  // ★ patch_file 替代通道：diff 过长时 LLM 写入评审目录文件、JSON 只放文件名，避免 19KB diff 撑破 extractJson
  const hasPatchFile = typeof v.patch_file === 'string' && v.patch_file.trim().length > 0;
  const choiceOk =
    v.verdict === 'regenerate'
      ? v.choice === 'regenerate' || MENTOR_CHOICE_VALUES.includes(v.choice)
      : MENTOR_CHOICE_VALUES.includes(v.choice) && (hasPolishPatch || hasPatchFile);
  if (!choiceOk) {
    return false;
  }
  // evaluation / ranking 为可选字段；存在时须结构合格（放宽校验，不强制回填）
  const evaluationOk = !v.evaluation || (Array.isArray(v.evaluation) && v.evaluation.every(isCandidateEval));
  const rankingOk = !v.ranking || (Array.isArray(v.ranking) && v.ranking.every((r) => typeof r === 'string'));
  return evaluationOk && rankingOk;
}

function fmtVerify(verify: VerifyResult): string {
  const probes = verify.probe_results
    .map((r) => `  - [${r.passed ? '符合预期' : '不符预期'}] 证据探针 ${r.probe_id}（${r.title}）★不计入验收★`)
    .join('\n');
  const pub =
    verify.public_ok === undefined
      ? ''
      : `\n  - [${verify.public_ok ? 'PASS' : 'FAIL'}] public 测试：${(verify.public_output ?? '').slice(0, 300)}`;
  return `结果：${verify.summary}\n${probes}${pub}`;
}

function fmtOutcome(label: string, outcome: MentorAgentOutcome, limit: number): string {
  const patch = outcome.patch.trim();
  const body =
    patch.length === 0
      ? '（该候选未产出任何 diff）'
      : patch.length > limit
        ? patch.slice(0, limit) + `\n…（补丁已截断，完整内容见 patch 工件）`
        : patch;
  const status = outcome.available
    ? ''
    : `\n⚠ 该候选被标记为不可用（${outcome.verify.summary}）：diff 可能不完整或被截断，请仔细核对后再决定是否使用或合成。`;
  return `${body}\n${status}\n${fmtVerify(outcome.verify)}`;
}

function probeCriteria(probes: { id: string; title: string; expect: string }[]): string {
  return probes
    .map((p) => `- [ ] [参考证据，不计入验收] 探针 ${p.id}（${p.title}）：${p.expect}`)
    .join('\n');
}

/** 解析进度文件（JSONL）为进度行；忽略无法解析的行。 */
export function parseMentorProgressLines(text: string): MentorProgressLine[] {
  const out: MentorProgressLine[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    try {
      const o = JSON.parse(line) as MentorProgressLine;
      if (o && typeof o === 'object' && typeof o.candidate === 'string') out.push(o);
    } catch {
      // 进度文件允许被截断/损坏，忽略坏行
    }
  }
  return out;
}

const MENTOR_PROGRESS_DIMENSIONS: (keyof MentorDimensionScores)[] = [
  'functional', 'numerical', 'scientific', 'robustness', 'intent', 'quality'
];

/** 会话结束后用进度文件回填 verdict.evaluation 中缺失的候选（不覆盖 LLM 最终 JSON 已有项）。 */
export function mergeMentorProgress(verdict: MentorVerdict, lines: MentorProgressLine[]): MentorVerdict {
  if (lines.length === 0) return verdict;
  const byCandidate = new Map<string, { scores: Partial<MentorDimensionScores>; cse?: boolean; violated_invariant?: string }>();
  for (const line of lines) {
    const entry = byCandidate.get(line.candidate) ?? { scores: {} };
    if (line.dimension !== undefined && typeof line.score === 'number' && Number.isFinite(line.score)
        && (MENTOR_PROGRESS_DIMENSIONS as string[]).includes(line.dimension)) {
      entry.scores[line.dimension] = Math.max(0, Math.min(10, line.score));
    }
    if (typeof line.cse === 'boolean') {
      entry.cse = line.cse;
      if (typeof line.violated_invariant === 'string' && line.violated_invariant.length > 0) {
        entry.violated_invariant = line.violated_invariant;
      }
    }
    byCandidate.set(line.candidate, entry);
  }
  const existing = new Set((verdict.evaluation ?? []).map((e) => e.candidate));
  const evals = [...(verdict.evaluation ?? [])];
  for (const [candidate, entry] of byCandidate) {
    if (existing.has(candidate)) continue;
    const complete = MENTOR_PROGRESS_DIMENSIONS.every((d) => entry.scores[d] !== undefined);
    if (!complete) continue;
    evals.push({
      candidate,
      scores: {
        functional: entry.scores.functional as number,
        numerical: entry.scores.numerical as number,
        scientific: entry.scores.scientific as number,
        robustness: entry.scores.robustness as number,
        intent: entry.scores.intent as number,
        quality: entry.scores.quality as number
      },
      cse: entry.cse ?? false,
      ...(entry.violated_invariant ? { violated_invariant: entry.violated_invariant } : {}),
      rationale: '（来自逐步评分进度文件回填）'
    });
  }
  verdict.evaluation = evals;
  return verdict;
}

/** 一行式进度摘要，供活动日志展示。 */
export function summarizeMentorProgress(lines: MentorProgressLine[]): string[] {
  const order: string[] = [];
  const dimScores = new Map<string, Partial<Record<keyof MentorDimensionScores, number>>>();
  const cse = new Map<string, boolean>();
  for (const line of lines) {
    if (!order.includes(line.candidate)) order.push(line.candidate);
    const m = dimScores.get(line.candidate) ?? {};
    if (line.dimension && typeof line.score === 'number') m[line.dimension] = line.score;
    dimScores.set(line.candidate, m);
    if (typeof line.cse === 'boolean') cse.set(line.candidate, line.cse);
  }
  return order.map((candidate) => {
    const m = dimScores.get(candidate) ?? {};
    const parts = MENTOR_PROGRESS_DIMENSIONS.filter((d) => m[d] !== undefined)
      .map((d) => `${d[0].toUpperCase()}${m[d]}`);
    return `[mentor-progress] ${candidate}: ${parts.join(' ') || '…'}${cse.has(candidate) ? ` | CSE=${cse.get(candidate) ? 'YES' : 'no'}` : ''}`;
  });
}

/** 组装 SciReviewer 双补丁对比评审 prompt：以可检查验收标准（E）为依据，非叙述性描述。 */
export function buildMentorPrompt(
  intake: string,
  probes: { id: string; title: string; expect: string }[],
  publicCommand: string,
  comparison: MentorComparison,
  context?: { progressFile?: string; workspaceRoot?: string; shotContent?: string; shotReferenceFiles?: string[]; reviewerSkillContent?: string }
): string {
  return `你是 "SciReviewer"（资深领域评审），以「领域感知的补丁评估与打磨者」身份工作。三位 SciPatcher 针对同一 bug 各产出一个补丁，已匿名化：Candidate 1 / Candidate 2 / Candidate 3（不要猜测其来源，不得以"哪个模型生成"作为评分依据）。

你需要评估候选补丁是否维持与函数目标、邻近标识符及相似逻辑的语义一致性：检查冲突、异常组合、潜在功能退化；判断哪个补丁真正实现了开发者的修复意图而没有牺牲正确性。你的评审依据是**验收标准（public 测试 + 契约条款）**，外加 prober 探针作为**参考证据**（探针通过与否不构成验收）+ 下方 scientific-aware rubric，不是叙述性描述。

=== 开发者修复意图（intake） ===
${intake}

=== 验收标准 E（可检查项；★ 验收 = public 测试 + 契约条款；探针只是参考证据、不计入验收 ★） ===
${probeCriteria(probes)}
${publicCommand.trim() ? `- [ ] public 测试：\`${publicCommand}\` 必须通过` : ''}
- [ ] 契约条款：须同时满足「验收范围」与「契约完整性」条款（见下）

${ACCEPTANCE_SCOPE_CLAUSE}

${CONTRACT_COMPLETENESS_CLAUSE}

${MENTOR_RUBRIC_CLAUSE}

${context?.shotContent ? `=== 参照样例 shot（三层结构：Contract / Failure Example / Gold Pattern）===
本 shot 是本任务经私有测试全量验证通过（reward=1）的人工样例，采用三层结构。你要从中学的是：
- Contract：本任务的 scientific contract 条款，以及哪些是 CSE 一票否决项（候选违反任一条款即 CSE=1，从候选池剔除）；
- Failure Example：什么"看起来正确但其实错"的形态不应得高分，以及打分时的常见证据陷阱；
- Gold Pattern：正确 patch 的关键语义（结构、符号约定、最小改动边界），作为 Scientific Validity 打分的参照系。
学习纪律：只学契约、判据与证据门槛，禁止逐行模仿或抄写样例代码；候选与 shot 的实现方式不同不是扣分理由，扣分只能基于候选自身的契约违反或缺失部件。
${(context.shotReferenceFiles ?? []).length ? `如需与完美 patch 逐行比对，可读参考件（reference artifacts）：
${(context.shotReferenceFiles ?? []).map((f) => `  - ${f}`).join('\n')}` : ''}

${context.shotContent.trim()}` : ''}

${context?.reviewerSkillContent ? `=== Reviewer Skill 方法学标准（必须遵循）===
${context.reviewerSkillContent.trim()}` : ''}

=== Candidate 1（匿名）===
${fmtOutcome('Candidate 1', comparison.sci, 6000)}

=== Candidate 2（匿名）===
${fmtOutcome('Candidate 2', comparison.general, 6000)}

=== Candidate 3（匿名）===
${fmtOutcome('Candidate 3', comparison.ds, 6000)}

你的评审分两步：
1. 打分：对三个候选各自按 rubric 逐维打分（0-10），判定 CSE，并给出 CSE 过滤后的 ranking；
2. 打磨：选出 CSE 过滤后加权分最高的候选（choice），以该候选补丁为主体修补打磨，产出最终补丁 patch。

=== 执行纪律（打分优先，禁止证据挖掘）===
- 本次评审禁止执行 shell 命令读源码、重跑探针、写临时脚本/临时目录；一切打分直接基于本 prompt 已提供的材料：三个 diff、verify 探针结果、public 测试输出、探针清单、bug 报告。
- 唯一允许的文件写入：verdict=accept 且打磨后 diff 过长无法嵌入 JSON 时，用 shell 命令把完整 diff 写入当前目录 polished-patch.diff，并在 JSON 的 patch_file 填该文件名；除此之外禁止写任何文件。
- 回复一开始立即开始逐维打分：先 Candidate 1 六维（每评完一维立即写进度文件一行），再 CSE 判定；然后 Candidate 2、Candidate 3 同样流程；再 ranking；最后打磨 patch 与最终 JSON。
- 引用证据只引用上面材料中可见的内容（diff hunk、verify 条目、探针期望行为）；对无法从已给材料确认的不变量，按补丁逻辑做保守判断并在 rationale 注明不确定点，不得另行收集证据。

打磨规则：
- 以所选候选补丁为主体：保留其正确部分，只做必要的局部修补；
- 可吸收其他落选候选中正确的部分（如更合理的边界处理），但不得改变整体修复思路；
- 禁止全新重写，禁止引入与 bug 无关的新功能；
- patch 必须满足：完整 unified diff（git diff 格式，路径相对仓库根，以 diff --git 开头），且 git apply --check 可通过（系统会先做 git apply --check，失败则丢弃并回退原始候选 diff）；
- patch 的修复效果须不低于所选候选（打磨后语义上优于或等于该候选）。

你的最终回复必须只包含一个 JSON 对象（可用 markdown 代码围栏），schema 如下：
{
  "verdict": "accept | regenerate",
  "choice": "candidate_1 | candidate_2 | candidate_3（verdict=accept 时必填：CSE 过滤后加权 argmax 胜者，即你打磨的对象）",
  "patch": "可选：基于所选候选修补打磨后的最终完整 unified diff（git diff 格式，路径相对仓库根，以 diff --git 开头，可直接 git apply）；若 diff 超过 300 行不要嵌入 JSON，改写入当前目录 polished-patch.diff 并在 patch_file 中给出文件名",
  "patch_file": "可选：打磨后 diff 已写入当前目录的文件名（如 polished-patch.diff）；填写后系统自动读取该文件作为最终补丁，此时 patch 可省略",
  "evaluation": [
    {
      "candidate": "candidate_1 | candidate_2 | candidate_3 | synthesized",
      "scores": { "functional": 0-10, "numerical": 0-10, "scientific": 0-10, "robustness": 0-10, "intent": 0-10, "quality": 0-10 },
      "cse": false,
      "violated_invariant": "cse=true 时必填：违反的关键科学不变量名称",
      "rationale": "逐维打分依据，必须引用具体证据（bug 报告/原始代码/补丁内容/探针结果/public 测试输出/不变量）"
    }
  ],
  "ranking": ["CSE 过滤后按加权分降序排列的候选标签，最优在前"],
  "semantic_issues": ["逐条列出语义冲突/功能退化/与意图不符之处，必须是可检查的具体问题；无问题则为空数组"],
  "guidance": "verdict=regenerate 时必填：定位到文件/函数的可执行修复指令，不写叙述性描述；accept 时可为空字符串"
}
规则：
- 仅当所选/合成补丁通过验收标准（= public 测试 + 「契约条款」；★ 探针失败不计入验收 ★，但须在 rationale 中说明探针失败是否指向真实缺陷）且 semantic_issues 为空时 verdict=accept
- 仅让可见失败消失、或依靠运行时副作用（如碰巧抛出异常）“通过”的补丁 → 判不合格（verdict=regenerate）
- CSE 硬约束：候选违反关键科学不变量即必须排除（系统会先过滤再取加权分最高者）；全部候选 CSE → verdict=regenerate 并给出 guidance
- choice 必须是 CSE 过滤后加权分最高、且可用并通过验收的候选；全部候选都不合格 → verdict=regenerate 并给出 guidance
- verdict=accept 时 patch / patch_file 二者其一必填：所选候选经打磨后的最终 diff，必须可 git apply 且效果不低于所选候选；若写文件须为完整文件（以 diff --git 开头）且位于当前目录
${context?.progressFile ? `
=== 逐步评分进度（强制，用户实时可见）===
当前工作目录是临时可写评分目录；主工作区在 ${context.workspaceRoot ?? '（当前目录）'}（只读，绝对路径可读）。
评估每个候选时，每完成一个维度立即用 shell 命令把一行 JSON 追加到 ${context.progressFile}（JSONL，一行一条，不要写其他文件）：
  printf '%s\\n' '{"candidate":"candidate_1","dimension":"functional","score":8}' >> ${context.progressFile}
- 维度名固定为：functional/numerical/scientific/robustness/intent/quality（0-10 整数）
- 每评完六维后立即完成 CSE 判定并追加一行：{"candidate":"candidate_1","cse":false} 或 {"candidate":"candidate_1","cse":true,"violated_invariant":"违反的不变量名"}
- 顺序：candidate_1 六维 + cse → candidate_2 六维 + cse → candidate_3 六维 + cse → ranking 与打磨 patch → 最终 JSON（回复一开始即从 candidate_1 第一维开始，不得先做其他事情）
- 最终 JSON 的 evaluation 分数必须与进度文件逐维一致（系统会用进度文件回填缺失项）` : ''}`;
}

/** "修补打磨"兜底选择结果：verdict JSON 不可用时，基于逐维评分进度（CSE 过滤 + 加权 argmax）选出的胜者及其基础 diff。 */
export interface MentorPolishSelection {
  source: 'sci' | 'general' | 'ds';
  candidateLabel: 'candidate_1' | 'candidate_2' | 'candidate_3';
  baseDiff: string;
  scores: MentorDimensionScores;
  weighted: number;
  note: string;
}

/** 从逐步评分进度 JSONL（verdict 最终 JSON 不可用时的兜底事实来源）计算 CSE 过滤 + 加权 argmax，得到"打磨"目标。无可用候选时返回 null。 */
export function resolvePolishSelectionFromProgress(
  lines: MentorProgressLine[],
  comparison: MentorComparison
): MentorPolishSelection | null {
  const byCandidate = new Map<string, { scores: Partial<MentorDimensionScores>; cse?: boolean }>();
  for (const line of lines) {
    const entry = byCandidate.get(line.candidate) ?? { scores: {} };
    if (
      line.dimension !== undefined &&
      typeof line.score === 'number' &&
      Number.isFinite(line.score) &&
      (MENTOR_PROGRESS_DIMENSIONS as string[]).includes(line.dimension)
    ) {
      entry.scores[line.dimension] = Math.max(0, Math.min(10, line.score));
    }
    if (typeof line.cse === 'boolean') entry.cse = line.cse;
    byCandidate.set(line.candidate, entry);
  }
  const dimKeys = Object.keys(MENTOR_RUBRIC_WEIGHTS) as (keyof MentorDimensionScores)[];
  const pairs: {
    source: 'sci' | 'general' | 'ds';
    label: 'candidate_1' | 'candidate_2' | 'candidate_3';
    outcome: MentorAgentOutcome;
    entry?: { scores: Partial<MentorDimensionScores>; cse?: boolean };
  }[] = [
    { source: 'sci', label: 'candidate_1', outcome: comparison.sci, entry: byCandidate.get('candidate_1') },
    { source: 'general', label: 'candidate_2', outcome: comparison.general, entry: byCandidate.get('candidate_2') },
    { source: 'ds', label: 'candidate_3', outcome: comparison.ds, entry: byCandidate.get('candidate_3') }
  ];
  const ranked = pairs
    .filter(
      (pair) =>
        pair.outcome.available &&
        pair.outcome.patch.trim().startsWith('diff') &&
        pair.entry !== undefined &&
        pair.entry!.cse !== true &&
        dimKeys.every((dim) => typeof pair.entry!.scores[dim] === 'number')
    )
    .map((pair) => ({ ...pair, weighted: mentorWeightedScore(pair.entry!.scores as MentorDimensionScores) }))
    .sort((a, b) => b.weighted - a.weighted);
  if (ranked.length === 0) return null;
  const winner = ranked[0];
  const loserNote =
    ranked.length > 1
      ? `落选 ${ranked[1].label}（source ${ranked[1].source}，加权 ${ranked[1].weighted.toFixed(2)}）`
      : '其他候选缺少完整进度评分或 diff 不可用';
  return {
    source: winner.source,
    candidateLabel: winner.label,
    baseDiff: winner.outcome.patch,
    scores: winner.entry!.scores as MentorDimensionScores,
    weighted: winner.weighted,
    note: `进度分兜底：${winner.label} 加权 ${winner.weighted.toFixed(2)} → 在其基础 diff 上修补打磨；${loserNote}`
  };
}

/** 统一"修补打磨"兜底的目标选择（终极确定性兜底）：verdict rubric 与逐维评分进度都不可用时，
 * ★ 只看 public 命令（去预言机化 2026-09-16）：探针是证据、不是私有测试，不参与选择 ★；
 * public 平局时按声明顺序 sci 优先。无可用候选时返回 null。 */
export function resolvePolishTargetByVerify(comparison: MentorComparison): MentorPolishSelection | null {
  const zeroScores: MentorDimensionScores = {
    functional: 0,
    numerical: 0,
    scientific: 0,
    robustness: 0,
    intent: 0,
    quality: 0
  };
  const verifyScore = (outcome: MentorAgentOutcome): number => {
    return outcome.verify.public_ok === true ? 1 : 0;
  };
  const pairs: { source: 'sci' | 'general' | 'ds'; label: 'candidate_1' | 'candidate_2' | 'candidate_3'; outcome: MentorAgentOutcome }[] = [
    { source: 'sci', label: 'candidate_1', outcome: comparison.sci },
    { source: 'general', label: 'candidate_2', outcome: comparison.general },
    { source: 'ds', label: 'candidate_3', outcome: comparison.ds }
  ];
  const usable = pairs.filter((pair) => pair.outcome.available && pair.outcome.patch.trim().startsWith('diff'));
  if (usable.length === 0) return null;
  // JS 排序稳定：得分相同时保持 sci（列在前）优先
  const ranked = [...usable].sort((a, b) => verifyScore(b.outcome) - verifyScore(a.outcome));
  const winner = ranked[0];
  const loserNote =
    ranked.length > 1
      ? `落选 ${ranked[1].label}（source ${ranked[1].source}，verify ${verifyScore(ranked[1].outcome)}）`
      : '其他候选 diff 不可用';
  return {
    source: winner.source,
    candidateLabel: winner.label,
    baseDiff: winner.outcome.patch,
    scores: zeroScores,
    weighted: 0,
    note: `逐维评分不可用；按 verify 得分确定性选择（终极兜底）：${winner.label} verify ${verifyScore(winner.outcome)} → 在其基础 diff 上修补打磨；${loserNote}`
  };
}

/** SciReviewer 评审会话：read-only 沙箱单次 codex exec；schema 不合格时 resume 补正一次。 */
export async function runMentor(
  intake: string,
  probes: { id: string; title: string; expect: string }[],
  publicCommand: string,
  comparison: MentorComparison,
  options: MentorRunOptions
): Promise<MentorResult> {
  const runOptions: CodexRunOptions = {
    codexPath: options.codexPath,
    model: options.model,
    sandbox: options.sandbox ?? 'danger-full-access',
    cwd: options.cwd,
    apiKey: options.apiKey,
    provider: options.provider,
    timeoutMs: options.timeoutMs ?? 20 * 60 * 1000,
    onActivity: options.onActivity
  };
  const prompt = buildMentorPrompt(intake, probes, publicCommand, comparison, {
    progressFile: options.progressFile,
    workspaceRoot: options.workspaceRoot,
    shotContent: options.shotContent,
    shotReferenceFiles: options.shotReferenceFiles,
    reviewerSkillContent: options.reviewerSkillContent
  });
  let result = await runCodexOnce(prompt, runOptions);
  let verdict: MentorVerdict | undefined;
  if (result.ok) {
    verdict = extractJson(result.text) as MentorVerdict | undefined;
    if (!validateMentorVerdict(verdict) && result.threadId) {
      result = await runCodexOnce(
        '你的输出不符合 schema。请只输出修正后的 JSON 对象（verdict/choice/patch/patch_file/evaluation/ranking/semantic_issues/guidance），不要输出其他内容。打磨补丁过长时可写入当前目录 polished-patch.diff 并只填 patch_file。',
        { ...runOptions, resumeThreadId: result.threadId }
      );
      verdict = extractJson(result.text) as MentorVerdict | undefined;
    }
  }
  if (result.ok && validateMentorVerdict(verdict)) {
    // ★ patch_file 回填：LLM 把打磨后 diff 写入评审目录文件时，读取并填入 patch，下游统一消费 verdict.patch
    if (verdict.patch_file && !(verdict.patch ?? '').trim().startsWith('diff')) {
      const patchFilePath = path.resolve(options.cwd, verdict.patch_file.trim());
      if (fs.existsSync(patchFilePath)) {
        const fromFile = fs.readFileSync(patchFilePath, 'utf8').trim();
        if (fromFile.startsWith('diff')) {
          verdict.patch = fromFile;
          options.onActivity?.(`[mentor] 打磨补丁已从文件读取: ${verdict.patch_file.trim()}`);
        } else {
          options.onActivity?.(`[mentor] patch_file（${verdict.patch_file.trim()}）内容不是 diff（未以 diff 开头），忽略`);
        }
      } else {
        options.onActivity?.(`[mentor] patch_file 不存在: ${patchFilePath}`);
      }
    }
    if (options.progressFile && fs.existsSync(options.progressFile)) {
      const lines = parseMentorProgressLines(fs.readFileSync(options.progressFile, 'utf8'));
      mergeMentorProgress(verdict, lines);
      for (const line of summarizeMentorProgress(lines)) {
        options.onActivity?.(line);
      }
    }
    return { ok: true, verdict };
  }
  return { ok: false, error: result.error ?? 'SciReviewer 输出不符合 schema' };
}

/** "修补打磨" prompt（统一兜底）：按规则（verdict rubric → 逐维评分进度 → verify 得分）选定更优候选后，
 * 在其基础 diff 之上修补打磨；胜者基础 diff 已预应用到工作副本（git diff vs HEAD = 基础补丁）；
 * 会话以 workspace-write 运行，任务是最小改动打磨而非从零重写。 */
export function buildMentorPolishPrompt(
  intake: string,
  probes: { id: string; title: string; expect: string }[],
  publicCommand: string,
  comparison: MentorComparison,
  selection: MentorPolishSelection,
  options: MentorRunOptions
): string {
  const SOURCE_TO_LABEL: Record<'sci' | 'general' | 'ds', string> = {
    sci: 'candidate_1',
    general: 'candidate_2',
    ds: 'candidate_3'
  };
  const others = (['sci', 'general', 'ds'] as const)
    .filter((s) => s !== selection.source)
    .map((s) => ({ source: s, label: SOURCE_TO_LABEL[s], outcome: comparison[s] }));
  const othersSections = others
    .map((o) => `=== 参考：落选候选 ${o.label}（source ${o.source}）的完整结果（仅吸收其中与基础补丁不冲突的正确部分）===\n${fmtOutcome(o.label, o.outcome, 4000)}`)
    .join('\n\n');
  const scoreLines = (Object.keys(MENTOR_RUBRIC_WEIGHTS) as (keyof MentorDimensionScores)[])
    .map((dim) => `- ${String(dim).padEnd(14)} ${String(selection.scores[dim]).padStart(4)} （权重 ${(MENTOR_RUBRIC_WEIGHTS[dim] * 100).toFixed(0)}%）`)
    .join('\n');
  return `你是 "SciReviewer"（资深领域评审）。已按规则选定更优候选 ${selection.candidateLabel}：其基础 diff 已预应用到当前工作区（git diff vs HEAD 即基础补丁）。本次不要重新评估，也不要从零写新补丁：你的任务是在该基础补丁之上做最小改动打磨，产出最终补丁。

=== 基础补丁状态（已预应用，git diff vs HEAD = 基础补丁）===
胜者: ${selection.candidateLabel}（source: ${selection.source}）
${selection.note}
逐维得分:
${scoreLines}
加权分: ${selection.weighted.toFixed(2)}/10

=== 开发者修复意图（intake） ===
${intake}

=== 验收标准 E（★ 验收 = public 测试 + 契约条款；探针只是参考证据、不计入验收 ★） ===
${probeCriteria(probes)}
${publicCommand.trim() ? `- [ ] public 测试：\`${publicCommand}\` 必须通过` : ''}
- [ ] 契约条款：须同时满足「验收范围」与「契约完整性」条款（见下）

${ACCEPTANCE_SCOPE_CLAUSE}

${CONTRACT_COMPLETENESS_CLAUSE}

=== 参考：胜者候选的完整结果 ===
${fmtOutcome(selection.candidateLabel, comparison[selection.source], 4000)}

${othersSections}

${options.guidance ? `=== 评审指导（上一轮给出的修复指令）===
${options.guidance.trim()}` : ''}

${options.progressSummary ? `=== 你上一轮提交的逐维评分进度（JSONL 原文）===
${options.progressSummary}` : ''}

${options.shotContent ? `=== 参照样例 shot（三层结构：Contract / Failure Example / Gold Pattern）===
${options.shotContent.trim()}
学习纪律：以 Contract 条款与 Gold Pattern 语义为准实现修复，禁止逐行模仿/抄写样例代码。
${(options.shotReferenceFiles ?? []).length ? `如需与完美 patch 逐行比对，可读参考件（reference artifacts）：
${(options.shotReferenceFiles ?? []).map((f) => `  - ${f}`).join('\n')}` : ''}` : ''}

${options.reviewerSkillContent ? `=== Reviewer Skill 方法学标准（必须遵循）===
${options.reviewerSkillContent.trim()}` : ''}

要求：
1. 最小改动纪律：保留基础补丁中正确的部分；不得推翻基础补丁整体结构、不得引入新功能、不得 git commit
2. public 测试或契约条款未通过时：逐一定位根因并做最小局部修补；可吸收其他落选候选中与基础补丁不冲突的正确部分。★ 探针失败先判断其断言是否真的属于契约（探针只是参考证据），再决定是否改代码 ★
3. 打磨后效果不得低于基础补丁：每做完一处局部修补立即做增量验证；全部修补完成后一次性跑 public 测试 + 契约自检 + 参考探针并逐条列出结果
4. 完成后逐条说明：public 测试与契约条款是否通过、参考探针逐条结果 + 相对基础补丁的每一处改动及理由
5. 执行纪律（硬约束，违反即视为会话失败）：
   - 禁止网络操作：不得使用 git clone / pip download / pip install / curl / wget 或任何方式拉取远端代码或依赖；所需上下文已在本工作区与本 prompt 材料中
   - 禁止广泛探索：读文件限于基础补丁触及的文件、任务文件（intake / 探针脚本 / public 测试）及其直接依赖；不得全仓库遍历、不得对比远端仓库/GitHub
   - 前 10 个动作内必须开始编辑目标文件：先修后验，禁止在没有任何编辑动作的情况下累计 10 个以上只读动作
   - 会话结束时的 git diff 就是提交用的最终补丁：任何时刻保持工作区 diff 完整且可 git apply --check，不得把中间破损状态留在工作区`;
}

/** 执行"修补打磨"会话：基础 diff 由调用方预应用；会话以 workspace-write 运行；diff 抓取由调用方负责。 */
export function runMentorPolish(
  intake: string,
  probes: { id: string; title: string; expect: string }[],
  publicCommand: string,
  comparison: MentorComparison,
  selection: MentorPolishSelection,
  options: MentorRunOptions
): ReturnType<typeof runCodexOnce> {
  return runCodexOnce(
    buildMentorPolishPrompt(intake, probes, publicCommand, comparison, selection, options),
    { ...options, sandbox: 'danger-full-access' }
  );
}
