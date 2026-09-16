import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  BaselineClassification,
  Probe,
  ProbeBaselineGate,
  ProbeBaselineResult,
  ProbeTestResult,
  VerifyResult
} from '../agents/schemas';

const PROBE_TIMEOUT_MS = 120_000;

/** 解析 python 解释器：优先显式配置，其次工作区 .venv，最后系统 python3。 */
export function resolvePython(workspaceRoot: string, configured: string): string {
  if (configured.trim()) {
    return configured.trim();
  }
  const venvPython = path.join(workspaceRoot, '.venv', 'bin', 'python');
  if (fs.existsSync(venvPython)) {
    return venvPython;
  }
  return 'python3';
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    execFile(command, args, { cwd, timeout: PROBE_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout, stderr) => {
      const output = (stdout + '\n' + stderr).trim().slice(-4000);
      if (err && typeof (err as { code?: unknown }).code === 'number') {
        resolve({ code: (err as { code: number }).code, output });
      } else if (err) {
        resolve({ code: -1, output: output || String(err) });
      } else {
        resolve({ code: 0, output });
      }
    });
  });
}

async function runProbe(
  probe: Probe,
  probesDir: string,
  workDir: string,
  pythonPath: string,
  env: NodeJS.ProcessEnv
): Promise<ProbeTestResult> {
  const ext = probe.kind === 'python' ? '.py' : '.sh';
  const file = path.join(probesDir, `${probe.id}${ext}`);
  fs.writeFileSync(file, probe.code);
  // ★ 探针执行路径约定（§41）★
  // 探针可能在两种「工作区根」解析方式中任选其一：
  //   (a) cwd 相对：sys.path.insert(0, 'source')            —— harness 以工作区根为 cwd 执行；
  //   (b) __file__ 相对：Path(__file__).resolve().parents[1]。
  // runDir/probes 只用于人工复核与 manifest 索引；执行时改放**工作区副本内的影子副本**
  // <workDir>/.sci-probes/，使 (b) 解析到同一工作区根，避免把「路径写法差异」误判成坏探针
  // （假阴性：套件明明有效，却被本底诊断误判为 import 失败）。
  const shadowDir = path.join(workDir, '.sci-probes');
  fs.mkdirSync(shadowDir, { recursive: true });
  const execFile = path.join(shadowDir, `${probe.id}${ext}`);
  fs.copyFileSync(file, execFile);
  const result =
    probe.kind === 'python'
      ? await runCommand(pythonPath, [execFile], workDir, env)
      : await runCommand('bash', [execFile], workDir, env);
  return { probe_id: probe.id, title: probe.title, passed: result.code === 0, output: result.output };
}

/**
 * 探针物化：把 run 目录下的探针写成独立可执行文件 + manifest.json，
 * 供后续任何阶段/工具自动读取（probes/manifest.json 为唯一索引）。
 * 返回 manifest 路径；无探针时返回 undefined。
 */
/** relDir 缺省 'probes'（legacy 行为）；角色子文件夹可传 'prober/<agent>/tests' 等嵌套路径。 */
export function materializeProbes(runDir: string, probes: Probe[], relDir: string = 'probes'): string | undefined {
  if (probes.length === 0) return undefined;
  const dir = path.join(runDir, relDir);
  fs.mkdirSync(dir, { recursive: true });
  const entries = probes.map((p) => ({
    id: p.id,
    title: p.title,
    kind: p.kind,
    dimension: p.dimension ?? '',
    expect: p.expect,
    file: `${p.id}${p.kind === 'python' ? '.py' : '.sh'}`,
    ...(typeof p.patcher_guidance === 'string' && p.patcher_guidance ? { patcher_guidance: p.patcher_guidance } : {}),
    ...(p.rank !== undefined && p.rank !== null ? { rank: p.rank } : {}),
    ...(typeof p.kill_line === 'string' && p.kill_line ? { kill_line: p.kill_line } : {}),
    ...(typeof p.falsifier === 'string' && p.falsifier ? { falsifier: p.falsifier } : {}),
    ...(typeof p.alt_sites === 'string' && p.alt_sites ? { alt_sites: p.alt_sites } : {})
  }));
  probes.forEach((p, i) => {
    fs.writeFileSync(path.join(dir, entries[i].file), p.code);
  });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ source: 'probe-stage', probes: entries }, null, 2));
  return path.join(dir, 'manifest.json');
}

/**
 * 自动读取历史 run 的探针：优先 probes/manifest.json（按索引读代码文件），
 * 无 manifest 时退回直接读 probes/ 下的 .py/.sh 文件。
 */
export function loadProbesFromRunDir(runDir: string): Probe[] {
  const dir = path.join(runDir, 'probes');
  const manifestFile = path.join(dir, 'manifest.json');
  if (fs.existsSync(manifestFile)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
      const list: unknown[] = Array.isArray(manifest) ? manifest : manifest.probes ?? [];
      return list
        .filter((m): m is Record<string, unknown> => !!m && typeof (m as Record<string, unknown>).file === 'string')
        .map((entry) => ({
          id: String(entry.id ?? ''),
          title: String(entry.title ?? ''),
          kind: entry.kind === 'shell' ? ('shell' as const) : ('python' as const),
          code: fs.readFileSync(path.join(dir, String(entry.file)), 'utf8'),
          expect: String(entry.expect ?? ''),
          dimension: typeof entry.dimension === 'string' && entry.dimension ? entry.dimension : undefined,
          patcher_guidance: typeof entry.patcher_guidance === 'string' && entry.patcher_guidance ? entry.patcher_guidance : undefined,
          rank: typeof entry.rank === 'number' || typeof entry.rank === 'string' ? entry.rank : undefined,
          kill_line: typeof entry.kill_line === 'string' && entry.kill_line ? entry.kill_line : undefined,
          falsifier: typeof entry.falsifier === 'string' && entry.falsifier ? entry.falsifier : undefined,
          alt_sites: typeof entry.alt_sites === 'string' && entry.alt_sites ? entry.alt_sites : undefined
        }));
    } catch {
      return [];
    }
  }
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.py') || f.endsWith('.sh'))
    .map((f) => ({
      id: f.replace(/\.(py|sh)$/, ''),
      title: f,
      kind: (f.endsWith('.py') ? 'python' : 'shell') as 'python' | 'shell',
      code: fs.readFileSync(path.join(dir, f), 'utf8'),
      expect: ''
    }));
}

/**
 * 确定性 Verifier（非 LLM）：在干净副本上依次运行全部探针与可选 public 命令。
 * workDir 是 repair agent 已经改过的工作区的副本——本函数自身不写被测代码。
 */
export async function verify(
  workDir: string,
  probes: Probe[],
  publicCommand: string,
  runDir: string,
  pythonPath?: string
): Promise<VerifyResult> {
  const probesDir = path.join(runDir, 'probes');
  fs.mkdirSync(probesDir, { recursive: true });

  // 在临时副本上验证，避免探针文件污染工作区
  const copyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sci-verify-'));
  await runCommand('cp', ['-a', workDir + '/.', copyDir], os.tmpdir());

  const python = pythonPath ?? resolvePython(workDir, '');
  // 把工作区 venv 的 bin 放到 PATH 最前，保证 public 命令里的 "python" 也命中 venv
  const venvBin = path.dirname(python);
  const env = {
    ...process.env,
    PATH: `${venvBin}:${process.env.PATH ?? ''}`,
    PYTHONPATH: [copyDir, process.env.PYTHONPATH].filter(Boolean).join(':')
  };

  try {
    const probeResults: ProbeTestResult[] = [];
    for (const probe of probes) {
      probeResults.push(await runProbe(probe, probesDir, copyDir, python, env));
    }
    let publicOk: boolean | undefined;
    let publicOutput: string | undefined;
    if (publicCommand.trim()) {
      const pub = await runCommand('bash', ['-lc', publicCommand], copyDir, env);
      if (pub.code === 0) {
        publicOk = true;
        publicOutput = pub.output;
      } else if (PUBLIC_ENV_FAILURE_PATTERNS.some((re) => re.test(pub.output))) {
        publicOk = undefined;
        publicOutput = `[环境不可用：该非零退出与候选补丁无关，判为 unknown，不计入门禁]\n${pub.output}`;
      } else {
        publicOk = false;
        publicOutput = pub.output;
      }
    }
    const failed = probeResults.filter((r) => !r.passed);
    // ★ 验收判定只由 public 命令决定（去预言机化）★
    //   prober 的探针是**证据/回归网**，不是私有测试、不是验收门禁：
    //     - 探针全绿 ≠ 修复正确（探针可能假绿、可能与官方验收无关）；
    //     - 探针失败 ≠ 修复失败（探针本身可能是错的）。
    //   因此 ok 只反映 public 结果；无 public 命令时判为通过，探针结果仅作为工件证据保留。
    // ★ 措辞纪律：探针**不是**测试，故 summary 里不出现「通过/未过」这类验收语，也不出现在失败原因里 ★
    const ok = publicOk !== false;
    const probeNote = `证据探针 ${probeResults.length - failed.length}/${probeResults.length} 条符合预期（仅参考证据，不构成验收）`;
    const summary = ok
      ? publicOk === true
        ? `public 测试通过；${probeNote}`
        : `无 public 命令：验收判为通过；${probeNote}`
      : `验收失败：public 测试失败`;
    return { ok, probe_results: probeResults, public_ok: publicOk, public_output: publicOutput, summary };
  } finally {
    fs.rmSync(copyDir, { recursive: true, force: true });
  }
}

// ============================================================================
// 本底判别诊断（deterministic，非 LLM；只出证据，不判分、不剔除、不阻断）
//
// 洞见：探针套件的价值只在它能**判别**时才成立。在 patcher 动手之前，每个探针
// 必须先跑一遍「未修复的本底」：
//   - 本底上失败  -> 有判别力，保留；
//   - 本底上通过  -> 假绿（false green），对本次修复零判别力，必须剔除/重写；
//   - 跑不起来    -> 坏探针（语法/导入/超时），同样剔除。
// 只有 P0/P1（或 hard_constraint）探针被标注为低信息量风险；其余仅记录，避免回归保护类
// 探针导致误伤。
// ============================================================================

/** 探针自身跑不起来的特征（与被测代码的真实缺陷无关）。 */
const BROKEN_PROBE_PATTERNS: RegExp[] = [
  /^ModuleNotFoundError/m,
  /^ImportError/m,
  /^SyntaxError/m,
  /^IndentationError/m,
  /^TabError/m
];

/** 环境不可用特征：探针连被测包都导入不到，说明跑错了解释器/工作区，而非探针有问题。 */
const ENV_UNAVAILABLE_PATTERNS: RegExp[] = [/No module named '(numpy|pydicom)['"]?/, /No module named/];

/**
 * public 复现脚本「因环境缺失而跑不起来」的特征：宿主缺依赖 / 解释器不对 / 命令不存在。
 * 这类非零退出不是候选补丁的错，必须判为 unknown 而不是 false——否则会把一个与
 * 探针无关的环境问题渲染成「你的补丁让 public 测试挂了」，误导 patcher 白跑多轮。
 */
const PUBLIC_ENV_FAILURE_PATTERNS: RegExp[] = [
  /ModuleNotFoundError/,
  /No module named/,
  /ImportError/,
  /command not found/,
  /Could not find a version that satisfies/
];

/** Python traceback 帧：`File "<path>", line N[, in <fn>]`。 */
const TRACEBACK_FRAME_RE = /File "([^"]+)", line (\d+)/g;

/**
 * 本底失败归因（probe_skill §7.3 本底协议）：取最深（最后一条）traceback 帧，
 * 判断失败是探针自己的断言触发的，还是发生在其断言之前（前置校验 / 无关异常）。
 * 仅用于证据与反射提示，不参与剔除判定。
 */
function attributeFailure(
  probeId: string,
  output: string
): { attribution: 'self' | 'external' | 'unknown'; attributed_frame?: string } {
  const frames = [...output.matchAll(TRACEBACK_FRAME_RE)];
  if (frames.length === 0) return { attribution: 'unknown' };
  const last = frames[frames.length - 1];
  const file = last[1];
  const attributed_frame = `${file}:${last[2]}`;
  const base = (file.split(/[\\/]/).pop() ?? file).toLowerCase();
  const self = base === `${probeId.toLowerCase()}.py` || base.startsWith(`${probeId.toLowerCase()}_`);
  return { attribution: self ? 'self' : 'external', attributed_frame };
}

function normalizePriority(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  const m = /^p?\s*([0-3])$/i.exec(s);
  return m ? `P${m[1]}` : 'unknown';
}

function classifyBaselineResult(
  probe: Probe,
  exitCode: number,
  output: string
): { priority: string; hardConstraint: boolean; blocking: boolean; classification: BaselineClassification } {
  const priority = normalizePriority(probe.priority);
  const hardConstraint = probe.hard_constraint === true;
  const blocking = hardConstraint || priority === 'P0' || priority === 'P1';
  const broken = exitCode === -1 || BROKEN_PROBE_PATTERNS.some((re) => re.test(output));
  const classification: BaselineClassification = exitCode === 0 ? 'non_discriminating' : broken ? 'broken' : 'discriminating';
  return { priority, hardConstraint, blocking, classification };
}

/**
 * 在**未修复的本底工作区**上执行全部探针，做一次纯诊断：这套探针有没有信号？
 * ★ 诊断结果不构成验收、不剔除探针、不阻断流程（探针是证据，不是门禁）。★
 * 本函数只读工作区（verify 在临时副本上运行），不修改被测代码。
 */
export async function runProbeBaselineGate(
  workspaceRoot: string,
  probes: Probe[],
  runDir: string,
  pythonPath?: string
): Promise<ProbeBaselineGate> {
  const empty: ProbeBaselineGate = {
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
  if (probes.length === 0) return empty;

  // verify() 自身在 tmp 副本上跑，且会把探针物化到 runDir/probes（幂等覆盖）
  const baseline = await verify(workspaceRoot, probes, '', runDir, pythonPath);
  const byId = new Map(probes.map((p) => [p.id, p]));

  const results: ProbeBaselineResult[] = baseline.probe_results.map((r) => {
    const probe = byId.get(r.probe_id) ?? ({ id: r.probe_id, title: r.title } as Probe);
    const cls = classifyBaselineResult(probe, r.passed ? 0 : 1, r.output);
    const attr = r.passed ? { attribution: 'self' as const } : attributeFailure(r.probe_id, r.output);
    return {
      probe_id: r.probe_id,
      title: r.title,
      priority: cls.priority,
      hard_constraint: cls.hardConstraint,
      blocking: cls.blocking,
      exit_code: r.passed ? 0 : 1,
      classification: cls.classification,
      attribution: attr.attribution,
      attributed_frame: attr.attributed_frame,
      output_tail: r.output.slice(-1200)
    };
  });

  const broken = results.filter((r) => r.classification === 'broken');
  const envUnavailable =
    broken.length === results.length &&
    broken.length > 0 &&
    results.every((r) => ENV_UNAVAILABLE_PATTERNS.some((re) => re.test(r.output_tail)));
  if (envUnavailable) {
    return {
      ...empty,
      executed: false,
      reason: 'environment',
      results,
      summary: `本底诊断无法执行：${results.length} 个探针全部因导入失败（疑似解释器/工作区错误）`,
      feedback: ''
    };
  }

  const falseGreenBlocking = results.filter((r) => r.blocking && r.classification === 'non_discriminating');
  const brokenBlocking = broken.filter((r) => r.blocking);
  const lowSignal = results.filter(
    (r) => r.classification === 'non_discriminating' || r.classification === 'broken'
  );
  const discriminating = results.filter((r) => r.classification === 'discriminating').map((r) => r.probe_id);
  const blockingProbes = [...falseGreenBlocking, ...brokenBlocking].map((r) => r.probe_id);

  // ★ 只是诊断信号：探针不是验收门禁，这里的 ok 不影响 run 成败，也不剔除任何探针 ★
  const ok = discriminating.length > 0;

  const lines: string[] = [];
  lines.push(`本底执行：${results.length} 个探针（本底失败/有判别力 ${discriminating.length}，本底通过/假绿 ${falseGreenBlocking.length}，跑不起来 ${broken.length}）`);
  if (discriminating.length > 0) lines.push(`有判别力：${discriminating.join(', ')}`);
  if (falseGreenBlocking.length > 0) {
    lines.push(`★ 假绿（在本底上就通过 = 对本次修复零判别力）：${falseGreenBlocking.map((r) => `${r.probe_id}[${r.priority}]`).join(', ')}`);
  }
  if (broken.length > 0) lines.push(`★ 坏探针（自身跑不起来）：${broken.map((r) => `${r.probe_id}[${r.priority}]`).join(', ')}`);
  if (discriminating.length === 0) lines.push('★ 没有任何探针在本底上失败：套件对本 bug 完全无判别力。');

  const feedbackLines: string[] = [
    '=== 本底执行证据（确定性诊断，非验收：探针已在你交付前跑过一遍未修复的本底）===',
    '下面每条都是实测结果，不是推测。你必须据此修订探针，而不是复述它们：',
    ''
  ];
  for (const r of results) {
    if (r.classification === 'discriminating') {
      feedbackLines.push(`- ${r.probe_id} [${r.priority}] 本底失败 ✓ 有判别力`);
    } else if (r.classification === 'non_discriminating') {
      feedbackLines.push(
        `- ${r.probe_id} [${r.priority}] ★ 本底**通过** → 假绿。它在修复前后行为相同，无法验收任何东西。` +
          `若你要保留它的判别力，可改断言契约要求中「本底尚未满足」的可观测量（probe_skill.md §7.3 本底协议 / §7.2 探针字段）；` +
          `★ 不是门禁：也可以原样保留并标 low_signal —— 本底通过的探针照交不误（§7.3）。`
      );
    } else {
      feedbackLines.push(
        `- ${r.probe_id} [${r.priority}] ★ 探针自身跑不起来 → 坏探针。请修正其导入/语法/路径（见下方实测输出），` +
          `不要把它当成「已发现 bug」。`
      );
    }
    if (r.output_tail.trim()) {
      feedbackLines.push(`  实测输出（截尾）: ${r.output_tail.trim().split('\n').slice(-6).join(' | ')}`);
    }
    if (r.classification === 'discriminating' && r.attribution === 'external') {
      feedbackLines.push(
        `  ★ 归因存疑（probe_skill.md §7.3 失败归因）：最深 traceback 帧在 ${r.attributed_frame ?? '被测代码内'}，` +
          `不在本探针的断言处 → 该失败发生在探针断言**之前**（前置校验 / 无关异常 / 未实现分支），` +
          `不能据此主张判别力。请确认这就是本任务的缺陷；否则改写探针使其控制流真正到达自身断言。`
      );
    } else if (r.classification === 'discriminating' && r.attribution === 'unknown') {
      feedbackLines.push(
        '  ★ 归因不明（probe_skill.md §7.3 失败归因）：输出里没有可解析的 Python traceback 帧（超时 / 非 Python 运行器）。' +
          '请在报告里给出归因证据（探针自身断言处的 file:line 与实测值），否则该探针不算判别。'
      );
    }
  }
  feedbackLines.push('');
  feedbackLines.push(
    '说明（★ 仅供参考，不是门禁 ★）：以上是探针在本底上的实测信号，用于帮助你判断自己的探针是否有信息量。' +
      '本底即通过的探针多半断言了修复前后相同的行为（对你主张的 bug 无判别力），建议重写使其断言本底尚未满足的可观测量；' +
      '但**是否保留由你判断**——若你认为该行为确实属于契约、只是本底恰好也满足，请在 open_question 中说明理由。' +
      '同理，跑不起来的探针请修正导入/语法/路径。**探针不会被剔除，也不会决定验收结果**：' +
      '最终验收只由 public 测试决定，你的探针是给 patcher 的证据与线索。'
  );

  const summary = lines.join('；');
  return {
    ok,
    executed: true,
    reason: ok ? 'ok' : 'no discriminating probe',
    results,
    blocking_probes: blockingProbes,
    excluded_probes: [],
    low_signal_probes: [...new Set(lowSignal.map((r) => r.probe_id))],
    discriminating,
    summary,
    feedback: feedbackLines.join('\n')
  };
}

/**
 * 把各 prober 角色的本底诊断合并为套件级诊断（按 probe_id 去重，先到先得）。
 * 仅用于给出「哪些探针信息量低」的提示；不剔除探针、不影响验收。
 */
export function aggregateProbeBaselineGates(gates: ProbeBaselineGate[]): ProbeBaselineGate {
  const usable = gates.filter((g) => g.results.length > 0);
  if (usable.length === 0) {
    return {
      ok: false,
      executed: false,
      reason: 'not-run',
      results: [],
      blocking_probes: [],
      excluded_probes: [],
      low_signal_probes: [],
      discriminating: [],
      summary: '本底诊断未执行（无逐角色实测结果）',
      feedback: ''
    };
  }

  const byId = new Map<string, ProbeBaselineResult>();
  for (const gate of usable) {
    for (const r of gate.results) {
      if (!byId.has(r.probe_id)) byId.set(r.probe_id, r);
    }
  }
  const results = [...byId.values()];
  const discriminating = results.filter((r) => r.classification === 'discriminating').map((r) => r.probe_id);
  const lowSignal = results.filter((r) => r.classification !== 'discriminating').map((r) => r.probe_id);
  const blocking = results
    .filter((r) => r.blocking && r.classification !== 'discriminating')
    .map((r) => r.probe_id);
  const falseGreen = results.filter((r) => r.classification === 'non_discriminating');
  const broken = results.filter((r) => r.classification === 'broken');
  // ★ 只是诊断信号（探针不是门禁）：不影响 run 成败，也不剔除探针 ★
  const ok = discriminating.length > 0;

  const lines = [
    `本底执行：${results.length} 个探针（本底失败/有判别力 ${discriminating.length}，本底通过/假绿 ${falseGreen.length}，跑不起来 ${broken.length}）`
  ];
  if (falseGreen.length > 0) {
    lines.push(`★ 低信息量（本底即通过 = 对本次修复无判别力，仅作参考、未剔除）：${falseGreen.map((r) => `${r.probe_id}[${r.priority}]`).join(', ')}`);
  }
  if (broken.length > 0) {
    lines.push(`★ 坏探针（自身跑不起来，仅作参考、未剔除）：${broken.map((r) => `${r.probe_id}[${r.priority}]`).join(', ')}`);
  }
  if (discriminating.length === 0) lines.push('★ 没有任何探针在本底上失败：套件对本 bug 无判别力。');

  const feedback = usable
    .map((g) => g.feedback)
    .filter((f) => f.trim())
    .join('\n\n');

  return {
    ok,
    executed: true,
    reason: ok ? 'ok' : 'no discriminating probe',
    results,
    blocking_probes: blocking,
    excluded_probes: [],
    low_signal_probes: lowSignal,
    discriminating,
    summary: lines.join('；'),
    feedback
  };
}
